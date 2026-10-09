import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { InboxRepository } from "../database/inbox.repository";
import { ApplicationMetrics, logStructured } from "../observability/metrics";
import {
  InvalidWagerRequestError,
  WagerTransactionRequest,
  canonicalJson,
  parseWagerRequestData,
  type WagerRequestData,
} from "../application/wager-transaction-request";
import { SqsQueues } from "./sqs-queues";

const CONSUMER_NAME = "wager-transaction-consumer";

class PermanentMessageError extends Error {}

export class WagerConsumer {
  constructor(
    private readonly orm: MikroORM,
    private readonly inbox: InboxRepository,
    private readonly requests: WagerTransactionRequest,
    private readonly queues: SqsQueues,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async pollOnce(): Promise<number> {
    if (!this.queues.queueUrl) throw new Error("Wager SQS queue is not initialized");
    const response = await this.queues.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queues.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 60,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }));
    const message = response.Messages?.[0];
    if (!message) return 0;

    await this.processMessage(message);
    return 1;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        logStructured("error", "sqs_consumer_poll_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        await delay(1000, signal);
      }
    }
  }

  private async processMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !message.MessageId) {
      throw new Error("SQS delivered a message without its required receipt metadata");
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(message.Body ?? "");
    } catch {
      await this.sendToDlqAndDelete(message, "INVALID_JSON");
      return;
    }

    let data: WagerRequestData;
    let messageId: string;
    let correlationId: string;
    let occurredAt: Date;
    try {
      if (!isRecord(envelope) || envelope.type !== "WagerTransactionRequested" ||
        !isRecord(envelope.data) || typeof envelope.messageId !== "string") {
        throw new InvalidWagerRequestError("Message envelope is invalid");
      }
      data = parseWagerRequestData(envelope.data);
      messageId = envelope.messageId;
      correlationId = typeof envelope.correlationId === "string"
        ? envelope.correlationId
        : messageId;
      occurredAt = typeof envelope.occurredAt === "string"
        ? new Date(envelope.occurredAt)
        : new Date();
      if (!Number.isFinite(occurredAt.getTime())) {
        throw new InvalidWagerRequestError("Message occurredAt is invalid");
      }
    } catch (error) {
      if (!(error instanceof InvalidWagerRequestError)) throw error;
      await this.sendToDlqAndDelete(message, "INVALID_MESSAGE");
      return;
    }

    const payloadHash = createHash("sha256").update(canonicalJson(envelope)).digest("hex");
    try {
      const outcome = await this.orm.em.transactional(async (em) => {
        const received = await this.inbox.receive(
          CONSUMER_NAME,
          messageId,
          payloadHash,
          em,
        );
        if (received === "PAYLOAD_CONFLICT") {
          throw new PermanentMessageError("Inbox message id reused with different payload");
        }
        if (received === "DUPLICATE") {
          this.metrics.recordDuplicate();
          return { status: "DUPLICATE" as const };
        }
        const result = await this.requests.submit(data, { correlationId, occurredAt }, em);
        await this.inbox.markProcessed(CONSUMER_NAME, messageId, em);
        return {
          status: "PROCESSED" as const,
          transactionId: result.transactionId,
        };
      });
      await this.deleteMessage(message.ReceiptHandle);
      logStructured("info", "sqs_message_acknowledged", {
        correlationId,
        messageId,
        ...("transactionId" in outcome ? { transactionId: outcome.transactionId } : {}),
        walletId: data.walletId,
        providerId: data.providerId,
        status: outcome.status,
      });
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        await this.sendToDlqAndDelete(message, "INBOX_PAYLOAD_CONFLICT");
        return;
      }
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
      this.metrics.recordRetry();
      await this.queues.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queues.queueUrl!,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.min(900, 2 ** Math.min(receiveCount, 9)),
      }));
      logStructured("warn", "sqs_message_retry_scheduled", {
        correlationId,
        messageId,
        walletId: data.walletId,
        providerId: data.providerId,
        attempt: receiveCount,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  private async sendToDlqAndDelete(message: Message, reason: string): Promise<void> {
    if (!this.queues.dlqUrl || !this.queues.queueUrl || !message.ReceiptHandle) {
      throw new Error("SQS queues are not initialized");
    }
    const dlqBody = JSON.stringify({
      originalMessageId: message.MessageId,
      reason,
      failedAt: new Date().toISOString(),
      body: message.Body ?? "",
    });
    await this.queues.client.send(new SendMessageCommand({
      QueueUrl: this.queues.dlqUrl,
      MessageBody: dlqBody,
      MessageGroupId: message.MessageId ?? "invalid-message",
      MessageDeduplicationId: `${message.MessageId ?? "invalid"}:${reason}`,
    }));
    this.metrics.recordDlq();
    await this.deleteMessage(message.ReceiptHandle);
    logStructured("error", "sqs_message_sent_to_dlq", {
      messageId: message.MessageId,
      reason,
    });
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.queues.client.send(new DeleteMessageCommand({
      QueueUrl: this.queues.queueUrl,
      ReceiptHandle: receiptHandle,
    }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
