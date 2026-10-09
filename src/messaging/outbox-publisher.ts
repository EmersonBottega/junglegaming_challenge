import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ApplicationMetrics, logStructured } from "../observability/metrics";
import { OutboxRepository, type ClaimedOutboxMessage } from "../database/outbox.repository";
import { SqsQueues } from "./sqs-queues";

export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly outbox: OutboxRepository,
    private readonly queues: SqsQueues,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async publishBatch(): Promise<number> {
    const owner = randomUUID();
    const messages = await this.orm.em.transactional((em) =>
      this.outbox.claimDue(owner, 10, 60, em),
    );
    for (const message of messages) {
      await this.publishOne(message, owner);
    }
    await this.updateLagMetric();
    return messages.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const count = await this.publishBatch();
        if (count === 0) await delay(1000, signal);
      } catch (error) {
        logStructured("error", "outbox_publisher_batch_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        await delay(2000, signal);
      }
    }
  }

  private async publishOne(message: ClaimedOutboxMessage, owner: string): Promise<void> {
    if (!this.queues.eventsQueueUrl) throw new Error("Wager events SQS queue is not initialized");
    const body = typeof message.payload === "string"
      ? message.payload
      : JSON.stringify(message.payload);
    try {
      await this.queues.client.send(new SendMessageCommand({
        QueueUrl: this.queues.eventsQueueUrl,
        MessageBody: body,
        MessageGroupId: message.aggregate_id,
        MessageDeduplicationId: message.id,
      }));
      await this.orm.em.transactional((em) => this.outbox.markPublished(message.id, owner, em));
      logStructured("info", "outbox_event_published", {
        correlationId: message.correlation_id,
        eventId: message.id,
        eventType: message.event_type,
        transactionId: message.transaction_id,
        walletId: message.aggregate_id,
        providerId: message.provider_id,
        aggregateId: message.aggregate_id,
      });
    } catch (error) {
      await this.orm.em.transactional((em) =>
        this.outbox.scheduleRetry(message.id, owner, retryDelay(message.attempts), em),
      );
      this.metrics.recordRetry();
      logStructured("warn", "outbox_event_retry_scheduled", {
        correlationId: message.correlation_id,
        eventId: message.id,
        eventType: message.event_type,
        transactionId: message.transaction_id,
        walletId: message.aggregate_id,
        providerId: message.provider_id,
        aggregateId: message.aggregate_id,
        attempt: message.attempts + 1,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  private async updateLagMetric(): Promise<void> {
    this.metrics.setOutboxLag(await this.outbox.oldestPendingLagSeconds(this.orm.em));
    if (!this.queues.dlqUrl) throw new Error("SQS dead-letter queue is not initialized");
    const attributes = await this.queues.getQueueAttributes(this.queues.dlqUrl);
    const visibleMessages = Number(attributes.ApproximateNumberOfMessages ?? "0");
    this.metrics.setDlqVisibleCount(visibleMessages);
  }
}

function retryDelay(attempts: number): number {
  return Math.min(300, 2 ** Math.min(attempts, 8));
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
