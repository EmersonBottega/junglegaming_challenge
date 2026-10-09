import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxPublisher } from "../messaging/outbox-publisher";
import { WagerConsumer } from "../messaging/wager-consumer";
import { SqsQueues } from "../messaging/sqs-queues";
import { ReferenceRetryWorker } from "./reference-retry-worker";
import { logStructured } from "../observability/metrics";

@Injectable()
export class ApplicationRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly abortController = new AbortController();
  private workers: Promise<void>[] = [];

  constructor(
    private readonly orm: MikroORM,
    private readonly queues: SqsQueues,
    private readonly publisher: OutboxPublisher,
    private readonly consumer: WagerConsumer,
    private readonly references: ReferenceRetryWorker,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queues.ensureQueues();
    const { signal } = this.abortController;
    this.workers = [
      this.publisher.run(signal),
      this.consumer.run(signal),
      this.references.run(signal),
    ];
    logStructured("info", "application_workers_started", {
      correlationId: crypto.randomUUID(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.abortController.abort();
    await Promise.all(this.workers);
    await this.queues.close();
    await this.orm.close(true);
    logStructured("info", "application_workers_stopped", {
      correlationId: crypto.randomUUID(),
    });
  }
}
