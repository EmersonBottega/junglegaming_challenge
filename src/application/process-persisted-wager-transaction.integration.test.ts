import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { WalletRepository } from "../database/wallet.repository";
import { WalletLedgerRepository } from "../database/wallet-ledger.repository";
import { WagerTransactionRepository } from "../database/wager-transaction.repository";
import { OutboxRepository } from "../database/outbox.repository";
import { createMikroOrmConfig } from "../database/mikro-orm.config";
import { ProcessPersistedWagerTransaction } from "./process-persisted-wager-transaction";
import { WagerTransactionRequest } from "./wager-transaction-request";
import { ReferenceRetryWorker } from "./reference-retry-worker";
import { ApplicationMetrics } from "../observability/metrics";
import type { IntegrationEvent } from "../domain/integration-event";
import type { EntityManager } from "@mikro-orm/postgresql";

describe("ProcessPersistedWagerTransaction with PostgreSQL", () => {
  let orm: MikroORM;
  let schema: string;
  let wallets: WalletRepository;
  let transactions: WagerTransactionRepository;
  let outbox: OutboxRepository;
  let processor: ProcessPersistedWagerTransaction;
  const additionalOrms: MikroORM[] = [];

  beforeAll(async () => {
    schema = `persisted_wager_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const config = createMikroOrmConfig();
    orm = new MikroORM({
      ...config,
      schema,
      migrations: {
        ...config.migrations,
        snapshotOnMigrate: false,
      },
    });
    await orm.connect();
    await orm.em.getConnection().execute(`CREATE SCHEMA "${schema}"`);
    await orm.migrator.up({ schema });

    wallets = new WalletRepository(orm.em);
    transactions = new WagerTransactionRepository(orm.em);
    outbox = new OutboxRepository(orm.em);
    processor = new ProcessPersistedWagerTransaction(
      orm.em,
      wallets,
      transactions,
      new WalletLedgerRepository(orm.em),
      outbox,
    );
  });

  afterAll(async () => {
    try {
      await Promise.all(additionalOrms.map((instance) => instance.close(true)));
      await orm.migrator.down({ schema });
      await orm.em.getConnection().execute(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await orm.close(true);
    }
  });

  test("allows exactly one of two concurrent 80 bets against a 100 balance", async () => {
    const wallet = await createWallet("100.00");
    const first = createBet(wallet.id, "80.00");
    const second = createBet(wallet.id, "80.00");

    const results = await Promise.all([
      process(first),
      process(second),
    ]);

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(results.find((result) => result.status === WagerTransactionStatus.Rejected)).toMatchObject({
      failureCode: FailureCode.InsufficientFunds,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("20.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countTransactions(wallet.id)).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionProcessed")).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionRejected")).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WalletBalanceChanged")).toBe(2);
  });

  test("processes fifty concurrent deliveries of one bet only once", async () => {
    const wallet = await createWallet("100.00");
    const original = createBet(wallet.id, "25.00");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => process(cloneTransaction(original))),
    );

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(50);
    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay === true)).toHaveLength(49);
    for (const result of results) {
      if (result.status === WagerTransactionStatus.Processed) {
        expect(result.balance.toString()).toBe("75.00");
      }
    }
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("75.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countTransactions(wallet.id)).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionProcessed")).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WalletBalanceChanged")).toBe(2);
  });

  test("keeps one idempotent result across three independent PostgreSQL instances", async () => {
    const wallet = await createWallet("100.00");
    const original = createBet(wallet.id, "25.00");
    const config = createMikroOrmConfig();
    const otherProcessors = await Promise.all([1, 2].map(async () => {
      const instance = new MikroORM({ ...config, schema });
      await instance.connect();
      additionalOrms.push(instance);
      const outbox = new OutboxRepository(instance.em);
      return new ProcessPersistedWagerTransaction(
        instance.em,
        new WalletRepository(instance.em, outbox),
        new WagerTransactionRepository(instance.em),
        new WalletLedgerRepository(instance.em),
        outbox,
      );
    }));
    const processors = [processor, ...otherProcessors];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        processors[index % processors.length].execute({
          transaction: cloneTransaction(original),
          ledgerEntryId: crypto.randomUUID(),
          processedAt: new Date(),
        }),
      ),
    );

    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay === true)).toHaveLength(49);
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("75.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countTransactions(wallet.id)).toBe(1);
  });

  test("processes different wallets in parallel without crossing their balances", async () => {
    const openedWallets = await Promise.all(
      Array.from({ length: 12 }, () => createWallet("50.00")),
    );
    const results = await Promise.all(openedWallets.map((wallet) => {
      const bet = createBet(wallet.id, "1.00");
      return processor.execute({
        transaction: bet,
        ledgerEntryId: crypto.randomUUID(),
        processedAt: new Date(),
      });
    }));

    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    const balances = await Promise.all(
      openedWallets.map(async (wallet) => (await wallets.findById(wallet.id))?.balance.toString()),
    );
    expect(balances).toEqual(Array(12).fill("49.00"));
    for (const wallet of openedWallets) {
      expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    }
  });

  test("preserves wallet-ledger consistency when a fresh service instance reads persisted state", async () => {
    const wallet = await createWallet("100.00");
    const bet = createBet(wallet.id, "35.00");
    await process(bet);

    const restartedOrm = new MikroORM({
      ...createMikroOrmConfig(),
      schema,
    });
    await restartedOrm.connect();
    additionalOrms.push(restartedOrm);
    const restartedWallets = new WalletRepository(restartedOrm.em);
    const restartedLedger = new WalletLedgerRepository(restartedOrm.em);
    const loadedWallet = await restartedWallets.findById(wallet.id);
    expect(loadedWallet?.balance.toString()).toBe("65.00");
    const reconciliation = await restartedLedger.reconcile(wallet.id, loadedWallet!.balance);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.calculatedBalance.toString()).toBe("65.00");
  });

  test("recovers an outbox lease left behind by a stopped publisher", async () => {
    await orm.em.getConnection().execute(
      `UPDATE "${schema}".outbox_message
       SET published_at = now(), lease_owner = NULL, lease_expires_at = NULL`,
    );
    const wallet = await createWallet("1.00");
    const [firstClaim] = await orm.em.transactional((em) =>
      outbox.claimDue("publisher-before-stop", 1, 60, em),
    );
    expect(firstClaim).toBeDefined();
    await orm.em.getConnection().execute(
      `UPDATE "${schema}".outbox_message
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = ?`,
      [firstClaim.id],
    );
    const [recoveredClaim] = await orm.em.transactional((em) =>
      outbox.claimDue("publisher-after-restart", 1, 60, em),
    );

    expect(recoveredClaim.id).toBe(firstClaim.id);
    await orm.em.transactional((em) =>
      outbox.markPublished(recoveredClaim.id, "publisher-after-restart", em),
    );
    const [remaining] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".outbox_message
       WHERE aggregate_id = ? AND published_at IS NULL`,
      [wallet.id],
    );
    expect(remaining.count).toBe("1");
  });

  test("returns an idempotency conflict when the same key has a different payload", async () => {
    const wallet = await createWallet("100.00");
    const original = createBet(wallet.id, "25.00");
    const processed = await process(original);
    expect(processed.status).toBe(WagerTransactionStatus.Processed);

    const changed = createBet(wallet.id, "30.00", {
      providerId: original.providerId,
      idempotencyKey: original.idempotencyKey,
      externalTransactionId: original.externalTransactionId,
      payloadHash: "different-payload",
    });
    const conflict = await process(changed);

    expect(conflict).toMatchObject({
      status: "IDEMPOTENCY_CONFLICT",
      transactionId: original.id,
      idempotentReplay: false,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("75.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
  });

  test("persists insufficient funds as a rejected transaction without ledger movement", async () => {
    const wallet = await createWallet("50.00");
    const bet = createBet(wallet.id, "80.00");

    const first = await process(bet);
    const replay = await process(cloneTransaction(bet));

    expect(first).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: true,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("50.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
    expect(await countTransactions(wallet.id)).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionRejected")).toBe(1);
  });

  test("rolls back the transaction and wallet update if the ledger insert fails", async () => {
    const walletId = crypto.randomUUID();
    const openingLedgerId = crypto.randomUUID();
    const wallet = await wallets.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: openingLedgerId,
    });
    const bet = createBet(wallet.id, "25.00");

    await expect(process(bet, openingLedgerId)).rejects.toThrow();

    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");
    expect(await transactions.findByIdempotencyKey(bet.providerId, bet.idempotencyKey)).toBeUndefined();
    expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
    expect(await countOutboxEvents(wallet.id)).toBe(2);
  });

  test("persists and replays a WIN credit with the original balance", async () => {
    const wallet = await createWallet("100.00");
    const win = createTransaction(WagerTransactionKind.Win, wallet.id, "35.00");

    const first = await process(win);
    const replay = await process(cloneTransaction(win));

    expect(first).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: Money.from({ amount: "135.00", currency: "BRL" }),
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: Money.from({ amount: "135.00", currency: "BRL" }),
      idempotentReplay: true,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("135.00");
    expect(await countLedger(wallet.id, "CREDIT")).toBe(2);
    expect(await countKind(wallet.id, WagerTransactionKind.Win)).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionProcessed")).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WalletBalanceChanged")).toBe(2);
    expect(await countOutboxPayloadEventId(wallet.id, "WalletBalanceChanged")).toBeTruthy();
  });

  test("persists LOSS without changing the wallet or adding a ledger entry", async () => {
    const wallet = await createWallet("100.00");
    const loss = createTransaction(WagerTransactionKind.Loss, wallet.id, "35.00");

    const result = await process(loss);
    const replay = await process(cloneTransaction(loss));

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: Money.from({ amount: "100.00", currency: "BRL" }),
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: Money.from({ amount: "100.00", currency: "BRL" }),
      idempotentReplay: true,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");
    expect(await countLedger(wallet.id, "CREDIT")).toBe(1);
    expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
    expect(await countKind(wallet.id, WagerTransactionKind.Loss)).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionProcessed")).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WalletBalanceChanged")).toBe(1);
  });

  test("retries a WIN in PENDING_REFERENCE after its BET reference is persisted", async () => {
    const wallet = await createWallet("100.00");
    const providerId = "provider-win-reference";
    const referencedBetExternalId = "bet-arrives-after-win";
    const win = createTransaction(WagerTransactionKind.Win, wallet.id, "20.00", {
      providerId,
      referenceExternalTransactionId: referencedBetExternalId,
    });

    const waiting = await process(win);
    const bet = createTransaction(WagerTransactionKind.Bet, wallet.id, "10.00", {
      providerId,
      externalTransactionId: referencedBetExternalId,
      idempotencyKey: "bet-arrives-after-win-key",
    });
    const betResult = await process(bet);
    const retried = await process(cloneTransaction(win));

    expect(waiting.status).toBe(WagerTransactionStatus.PendingReference);
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(retried).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: Money.from({ amount: "110.00", currency: "BRL" }),
      idempotentReplay: false,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("110.00");
    expect(await countKind(wallet.id, WagerTransactionKind.Win)).toBe(1);
    expect(await countLedger(wallet.id, "CREDIT")).toBe(2);
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionPendingReference")).toBe(1);
  });

  test("persists a REFUND credit and rejects concurrent duplicate refunds", async () => {
    const wallet = await createWallet("100.00");
    const bet = createTransaction(WagerTransactionKind.Bet, wallet.id, "40.00", {
      providerId: "provider-refund",
      externalTransactionId: "bet-to-refund",
      idempotencyKey: "bet-to-refund-key",
    });
    expect((await process(bet)).status).toBe(WagerTransactionStatus.Processed);

    const refunds = [
      createTransaction(WagerTransactionKind.Refund, wallet.id, "40.00", {
        providerId: bet.providerId,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      createTransaction(WagerTransactionKind.Refund, wallet.id, "40.00", {
        providerId: bet.providerId,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    ];
    const results = await Promise.all(refunds.map((refund) => process(refund)));

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(results.find((result) => result.status === WagerTransactionStatus.Rejected)).toMatchObject({
      failureCode: FailureCode.DuplicateReversal,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");
    expect(await countKind(wallet.id, WagerTransactionKind.Refund)).toBe(2);
    expect(await countLedger(wallet.id, "CREDIT")).toBe(2);
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionRejected")).toBe(1);
  });

  test("persists a ROLLBACK with the inverse movement and prevents duplicate rollback", async () => {
    const wallet = await createWallet("100.00");
    const win = createTransaction(WagerTransactionKind.Win, wallet.id, "30.00", {
      providerId: "provider-rollback",
      externalTransactionId: "win-to-rollback",
      idempotencyKey: "win-to-rollback-key",
    });
    expect((await process(win)).status).toBe(WagerTransactionStatus.Processed);

    const rollbacks = [
      createTransaction(WagerTransactionKind.Rollback, wallet.id, "30.00", {
        providerId: win.providerId,
        referenceExternalTransactionId: win.externalTransactionId,
      }),
      createTransaction(WagerTransactionKind.Rollback, wallet.id, "30.00", {
        providerId: win.providerId,
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    ];
    const results = await Promise.all(rollbacks.map((rollback) => process(rollback)));

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(results.find((result) => result.status === WagerTransactionStatus.Rejected)).toMatchObject({
      failureCode: FailureCode.DuplicateReversal,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countKind(wallet.id, WagerTransactionKind.Rollback)).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionRejected")).toBe(1);
  });

  test("persists a ROLLBACK rejection when its inverse debit would overdraw", async () => {
    const wallet = await createWallet("100.00");
    const win = createTransaction(WagerTransactionKind.Win, wallet.id, "30.00", {
      providerId: "provider-overdraw",
      externalTransactionId: "win-to-overdraw",
      idempotencyKey: "win-to-overdraw-key",
    });
    await process(win);
    const spend = createTransaction(WagerTransactionKind.Bet, wallet.id, "120.00", {
      providerId: "provider-overdraw",
      externalTransactionId: "spend-after-win",
      idempotencyKey: "spend-after-win-key",
    });
    await process(spend);
    const rollback = createTransaction(WagerTransactionKind.Rollback, wallet.id, "30.00", {
      providerId: win.providerId,
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const result = await process(rollback);

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalWouldOverdraw,
      idempotentReplay: false,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("10.00");
    expect(await countKind(wallet.id, WagerTransactionKind.Rollback)).toBe(1);
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionRejected")).toBe(1);
  });

  test("retries a missing reference and eventually rejects it with an integration event", async () => {
    const wallet = await createWallet("100.00");
    const metrics = new ApplicationMetrics();
    const requests = new WagerTransactionRequest(processor, metrics);
    const worker = new ReferenceRetryWorker(transactions, requests, processor, metrics);
    const request = {
      providerId: "provider-reference-retry",
      externalTransactionId: "refund-pending",
      idempotencyKey: "refund-pending-key",
      playerId: `player-${wallet.id}`,
      walletId: wallet.id,
      roundId: "round-reference",
      gameId: "game-reference",
      kind: WagerTransactionKind.Refund,
      money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-not-yet-seen",
    };

    const initial = await requests.submit(request);
    expect(initial.status).toBe(WagerTransactionStatus.PendingReference);
    await orm.em.getConnection().execute(
      `UPDATE "${schema}".wager_transaction
       SET reference_next_attempt_at = now() - interval '1 second',
           reference_expires_at = now() + interval '1 hour'
       WHERE provider_id = ? AND idempotency_key = ?`,
      [request.providerId, request.idempotencyKey],
    );

    const retryCounts = await Promise.all([
      worker.processDueBatch(),
      worker.processDueBatch(),
    ]);
    expect(retryCounts[0] + retryCounts[1]).toBe(1);
    const pending = await transactions.findById(initial.transactionId);
    expect(pending?.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    const [retryRow] = await orm.em.getConnection().execute(
      `SELECT reference_attempts FROM "${schema}".wager_transaction WHERE id = ?`,
      [initial.transactionId],
    );
    expect(retryRow.reference_attempts).toBe(2);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionPendingReference")).toBe(1);
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");

    await orm.em.getConnection().execute(
      `UPDATE "${schema}".wager_transaction
       SET reference_attempts = 12,
           reference_next_attempt_at = now() - interval '1 second',
           reference_expires_at = now() - interval '1 second'
       WHERE id = ?`,
      [initial.transactionId],
    );
    expect(await worker.processDueBatch()).toBe(1);
    const rejected = await transactions.findById(initial.transactionId);
    expect(rejected?.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected?.transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await countOutboxEvents(wallet.id, "WagerTransactionRejected")).toBe(1);
  });

  test("rolls back all financial writes if outbox persistence fails after inserting an event", async () => {
    const wallet = await createWallet("100.00");
    const bet = createBet(wallet.id, "25.00");
    const failingOutbox = new class extends OutboxRepository {
      override async enqueue(
        event: IntegrationEvent<unknown>,
        entityManager: EntityManager = orm.em,
      ): Promise<void> {
        await super.enqueue(event, entityManager);
        throw new Error("Injected failure after outbox insert");
      }
    }(orm.em);
    const failingProcessor = new ProcessPersistedWagerTransaction(
      orm.em,
      wallets,
      transactions,
      new WalletLedgerRepository(orm.em),
      failingOutbox,
    );

    await expect(failingProcessor.execute({
      transaction: bet,
      ledgerEntryId: crypto.randomUUID(),
      processedAt: new Date("2026-10-09T14:01:00.000Z"),
    })).rejects.toThrow("Injected failure after outbox insert");

    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");
    expect(await transactions.findByIdempotencyKey(bet.providerId, bet.idempotencyKey)).toBeUndefined();
    expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
    expect(await countOutboxEvents(wallet.id)).toBe(2);
  });

  async function createWallet(initialBalance: string) {
    const id = crypto.randomUUID();
    return wallets.open({
      id,
      playerId: `player-${id}`,
      initialBalance: Money.from({ amount: initialBalance, currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
    });
  }

  function createBet(
    walletId: string,
    amount: string,
    overrides: {
      providerId?: string;
      idempotencyKey?: string;
      externalTransactionId?: string;
      payloadHash?: string;
    } = {},
  ): WagerTransaction {
    return createTransaction(WagerTransactionKind.Bet, walletId, amount, overrides);
  }

  function createTransaction(
    kind: WagerTransactionKind,
    walletId: string,
    amount: string,
    overrides: {
      providerId?: string;
      idempotencyKey?: string;
      externalTransactionId?: string;
      payloadHash?: string;
      referenceExternalTransactionId?: string;
    } = {},
  ): WagerTransaction {
    const id = crypto.randomUUID();
    return WagerTransaction.create({
      id,
      providerId: overrides.providerId ?? `provider-${crypto.randomUUID()}`,
      externalTransactionId: overrides.externalTransactionId ?? `external-${crypto.randomUUID()}`,
      idempotencyKey: overrides.idempotencyKey ?? `key-${id}`,
      payloadHash: overrides.payloadHash ?? `payload-${crypto.randomUUID()}`,
      walletId,
      playerId: `player-${walletId}`,
      roundId: "round-1",
      gameId: "game-1",
      kind,
      money: Money.from({ amount, currency: "BRL" }),
      referenceExternalTransactionId: overrides.referenceExternalTransactionId,
      createdAt: new Date("2026-10-09T14:00:00.000Z"),
    });
  }

  function cloneTransaction(transaction: WagerTransaction): WagerTransaction {
    return createTransaction(transaction.kind, transaction.walletId, transaction.money.toString(), {
      providerId: transaction.providerId,
      idempotencyKey: transaction.idempotencyKey,
      externalTransactionId: transaction.externalTransactionId,
      payloadHash: transaction.payloadHash,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    });
  }

  function process(transaction: WagerTransaction, ledgerEntryId = crypto.randomUUID()) {
    return processor.execute({
      transaction,
      ledgerEntryId,
      processedAt: new Date("2026-10-09T14:01:00.000Z"),
    });
  }

  async function countLedger(walletId: string, direction: string): Promise<number> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wallet_ledger_entry
       WHERE wallet_id = ? AND direction = ?`,
      [walletId, direction],
    );
    return Number(result.count);
  }

  async function countTransactions(walletId: string): Promise<number> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wager_transaction
       WHERE wallet_id = ? AND kind = 'BET'`,
      [walletId],
    );
    return Number(result.count);
  }

  async function countKind(
    walletId: string,
    kind: WagerTransactionKind,
  ): Promise<number> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wager_transaction
       WHERE wallet_id = ? AND kind = ?`,
      [walletId, kind],
    );
    return Number(result.count);
  }

  async function countOutboxEvents(walletId: string, eventType?: string): Promise<number> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".outbox_message
       WHERE aggregate_id = ?${eventType ? " AND event_type = ?" : ""}`,
      eventType ? [walletId, eventType] : [walletId],
    );
    return Number(result.count);
  }

  async function countOutboxPayloadEventId(walletId: string, eventType: string): Promise<string | null> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT payload->>'eventId' AS event_id
       FROM "${schema}".outbox_message
       WHERE aggregate_id = ? AND event_type = ?
       LIMIT 1`,
      [walletId, eventType],
    );
    return result?.event_id ?? null;
  }
});
