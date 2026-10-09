import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import { createMikroOrmConfig } from "../database/mikro-orm.config";
import { InboxRepository } from "../database/inbox.repository";
import { OutboxRepository } from "../database/outbox.repository";
import { WalletLedgerRepository } from "../database/wallet-ledger.repository";
import { WalletRepository } from "../database/wallet.repository";
import { WagerTransactionRepository } from "../database/wager-transaction.repository";
import { ProcessPersistedWagerTransaction } from "../application/process-persisted-wager-transaction";
import {
  canonicalJson,
  parseWagerRequestData,
  WagerTransactionRequest,
} from "../application/wager-transaction-request";
import { ApplicationMetrics } from "../observability/metrics";
import { OutboxPublisher } from "./outbox-publisher";
import { SqsQueues } from "./sqs-queues";
import { WagerConsumer } from "./wager-consumer";

describe("wager processing with PostgreSQL and LocalStack SQS", () => {
  let orm: MikroORM;
  let schema: string;
  let queues: SqsQueues;
  let metrics: ApplicationMetrics;
  let consumer: WagerConsumer;
  let publisher: OutboxPublisher;
  let wallets: WalletRepository;
  let inbox: InboxRepository;
  let requests: WagerTransactionRequest;
  const additionalOrms: MikroORM[] = [];
  let savedQueueEnvironment: Record<string, string | undefined>;

  beforeAll(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    schema = `sqs_test_${suffix}`;
    savedQueueEnvironment = {
      AWS_REGION: process.env.AWS_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      SQS_ENDPOINT: process.env.SQS_ENDPOINT,
      SQS_QUEUE_NAME: process.env.SQS_QUEUE_NAME,
      SQS_DLQ_NAME: process.env.SQS_DLQ_NAME,
      SQS_EVENTS_QUEUE_NAME: process.env.SQS_EVENTS_QUEUE_NAME,
    };
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.SQS_ENDPOINT = "http://localhost:4566";
    process.env.SQS_QUEUE_NAME = `wager-test-${suffix}.fifo`;
    process.env.SQS_DLQ_NAME = `wager-test-dlq-${suffix}.fifo`;
    process.env.SQS_EVENTS_QUEUE_NAME = `wager-test-events-${suffix}.fifo`;
    queues = new SqsQueues();
    await queues.ensureQueues();

    const config = createMikroOrmConfig();
    orm = new MikroORM({
      ...config,
      schema,
      migrations: { ...config.migrations, snapshotOnMigrate: false },
    });
    await orm.connect();
    await orm.em.getConnection().execute(`CREATE SCHEMA "${schema}"`);
    await orm.migrator.up({ schema });

    const outbox = new OutboxRepository(orm.em);
    const transactions = new WagerTransactionRepository(orm.em);
    wallets = new WalletRepository(orm.em, outbox);
    const ledger = new WalletLedgerRepository(orm.em);
    metrics = new ApplicationMetrics();
    const processor = new ProcessPersistedWagerTransaction(
      orm.em,
      wallets,
      transactions,
      ledger,
      outbox,
      metrics,
    );
    requests = new WagerTransactionRequest(processor, metrics);
    inbox = new InboxRepository(orm.em);
    consumer = new WagerConsumer(
      orm,
      inbox,
      requests,
      queues,
      metrics,
    );
    publisher = new OutboxPublisher(orm, outbox, queues, metrics);
  }, 30_000);

  afterAll(async () => {
    try {
      if (orm) {
        await Promise.all(additionalOrms.map((instance) => instance.close(true)));
        await orm.migrator.down({ schema });
        await orm.em.getConnection().execute(`DROP SCHEMA "${schema}" CASCADE`);
        await orm.close(true);
      }
    } finally {
      if (queues) await queues.close();
      for (const [name, value] of Object.entries(savedQueueEnvironment ?? {})) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);

  test("deduplicates a redelivered request, publishes committed outbox events, and dead-letters invalid JSON", async () => {
    const walletId = crypto.randomUUID();
    await wallets.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
    });
    if (!queues.queueUrl || !queues.eventsQueueUrl || !queues.dlqUrl) {
      throw new Error("SQS queues were not initialized for the integration test");
    }
    const messageId = crypto.randomUUID();
    const envelope = {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "integration-provider",
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        playerId: `player-${walletId}`,
        walletId,
        roundId: "round-integration",
        gameId: "game-integration",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
    };
    const sendRequest = (deduplicationId: string) =>
      queues.client.send(new SendMessageCommand({
        QueueUrl: queues.queueUrl!,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: deduplicationId,
      }));
    await sendRequest(`${messageId}-first`);
    expect(await consumer.pollOnce()).toBe(1);
    expect((await wallets.findById(walletId))?.balance.toString()).toBe("75.00");

    const [processedInboxRow] = await orm.em.getConnection().execute(
      `SELECT processed_at IS NOT NULL AS processed
       FROM "${schema}".inbox_message
       WHERE consumer_name = ? AND message_id = ?`,
      ["wager-transaction-consumer", messageId],
    );
    expect(processedInboxRow.processed).toBe(true);

    await sendRequest(`${messageId}-redelivery`);
    expect(await consumer.pollOnce()).toBe(1);
    expect((await wallets.findById(walletId))?.balance.toString()).toBe("75.00");
    const [ledgerCount] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wallet_ledger_entry
       WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [walletId],
    );
    expect(ledgerCount.count).toBe("1");

    const crashWalletId = crypto.randomUUID();
    await wallets.open({
      id: crashWalletId,
      playerId: `player-${crashWalletId}`,
      initialBalance: Money.from({ amount: "40.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
    });
    const crashEnvelope = {
      messageId: crypto.randomUUID(),
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "integration-provider",
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        playerId: `player-${crashWalletId}`,
        walletId: crashWalletId,
        roundId: "round-crash-recovery",
        gameId: "game-integration",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
    };
    await queues.client.send(new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: JSON.stringify(crashEnvelope),
      MessageGroupId: crashWalletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }));
    const receivedBeforeCrash = await queues.client.send(new ReceiveMessageCommand({
      QueueUrl: queues.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 60,
    }));
    const [unackedMessage] = receivedBeforeCrash.Messages ?? [];
    if (!unackedMessage?.ReceiptHandle) {
      throw new Error("Test request was not received before simulated consumer crash");
    }
    const crashData = parseWagerRequestData(crashEnvelope.data);
    await orm.em.transactional(async (em) => {
      const payloadHash = createHash("sha256")
        .update(canonicalJson(crashEnvelope))
        .digest("hex");
      const receipt = await inbox.receive(
        "wager-transaction-consumer",
        crashEnvelope.messageId,
        payloadHash,
        em,
      );
      if (receipt !== "RECEIVED") {
        throw new Error(`Unexpected inbox outcome before simulated crash: ${receipt}`);
      }
      await requests.submit(
        crashData,
        {
          correlationId: crashEnvelope.messageId,
          occurredAt: new Date(crashEnvelope.occurredAt),
        },
        em,
      );
      await inbox.markProcessed(
        "wager-transaction-consumer",
        crashEnvelope.messageId,
        em,
      );
    });
    await queues.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queues.queueUrl,
      ReceiptHandle: unackedMessage.ReceiptHandle,
      VisibilityTimeout: 0,
    }));
    expect(await consumer.pollOnce()).toBe(1);
    expect((await wallets.findById(crashWalletId))?.balance.toString()).toBe("30.00");
    const [crashLedgerCount] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wallet_ledger_entry
       WHERE wallet_id = ? AND direction = 'DEBIT'`,
      [crashWalletId],
    );
    expect(crashLedgerCount.count).toBe("1");

    const secondaryOrm = new MikroORM({
      ...createMikroOrmConfig(),
      schema,
    });
    await secondaryOrm.connect();
    additionalOrms.push(secondaryOrm);
    const secondaryOutbox = new OutboxRepository(secondaryOrm.em);
    const secondaryPublisher = new OutboxPublisher(
      secondaryOrm,
      secondaryOutbox,
      queues,
      metrics,
    );
    const publishedCounts = await Promise.all([
      publisher.publishBatch(),
      secondaryPublisher.publishBatch(),
    ]);
    expect(publishedCounts[0] + publishedCounts[1]).toBe(8);
    const published = await queues.client.send(new ReceiveMessageCommand({
      QueueUrl: queues.eventsQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    }));
    expect(published.Messages).toHaveLength(8);
    const eventTypes = (published.Messages ?? []).map((message) => {
      if (!message.Body) throw new Error("Published outbox message had an empty body");
      return (JSON.parse(message.Body) as { eventType: string }).eventType;
    });
    expect(eventTypes).toContain("WagerTransactionProcessed");
    expect(eventTypes).toContain("WalletBalanceChanged");
    for (const message of published.Messages ?? []) {
      if (message.ReceiptHandle) {
        await queues.client.send(new DeleteMessageCommand({
          QueueUrl: queues.eventsQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }));
      }
    }

    await queues.client.send(new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: "{invalid-json",
      MessageGroupId: "invalid-json",
      MessageDeduplicationId: crypto.randomUUID(),
    }));
    expect(await consumer.pollOnce()).toBe(1);
    const deadLetter = await queues.client.send(new ReceiveMessageCommand({
      QueueUrl: queues.dlqUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
    }));
    const [deadLetterMessage] = deadLetter.Messages ?? [];
    expect(deadLetterMessage?.Body).toBeDefined();
    expect(JSON.parse(deadLetterMessage!.Body!).reason).toBe("INVALID_JSON");
    expect(metrics.toPrometheus()).toContain("wager_dlq_messages_total 1");

    const retryMessageId = crypto.randomUUID();
    await queues.client.send(new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: JSON.stringify({
        messageId: retryMessageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "integration-provider",
          externalTransactionId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          playerId: "player-not-created-yet",
          walletId: crypto.randomUUID(),
          roundId: "round-transient-retry",
          gameId: "game-integration",
          kind: "BET",
          money: { amount: "1.00", currency: "BRL" },
        },
      }),
      MessageGroupId: "transient-retry",
      MessageDeduplicationId: retryMessageId,
    }));
    expect(await consumer.pollOnce()).toBe(1);
    const retriedMessage = await queues.client.send(new ReceiveMessageCommand({
      QueueUrl: queues.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 3,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }));
    const [retryDelivery] = retriedMessage.Messages ?? [];
    expect(retryDelivery?.Attributes?.ApproximateReceiveCount).toBe("2");
    if (retryDelivery?.ReceiptHandle) {
      await queues.client.send(new DeleteMessageCommand({
        QueueUrl: queues.queueUrl,
        ReceiptHandle: retryDelivery.ReceiptHandle,
      }));
    }
    expect(metrics.toPrometheus()).toContain("wager_retries_total 1");
  }, 30_000);
});
