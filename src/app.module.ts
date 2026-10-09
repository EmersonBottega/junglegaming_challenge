import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ApplicationRuntime } from "./application/application-runtime";
import { ProcessPersistedWagerTransaction } from "./application/process-persisted-wager-transaction";
import { ReferenceRetryWorker } from "./application/reference-retry-worker";
import { WagerTransactionRequest } from "./application/wager-transaction-request";
import { InboxRepository } from "./database/inbox.repository";
import { OutboxRepository } from "./database/outbox.repository";
import { createMikroOrmConfig } from "./database/mikro-orm.config";
import { WalletLedgerRepository } from "./database/wallet-ledger.repository";
import { WalletRepository } from "./database/wallet.repository";
import { WagerTransactionRepository } from "./database/wager-transaction.repository";
import { HealthController } from "./health/health.controller";
import { WalletController } from "./http/wallet.controller";
import { WagerTransactionController } from "./http/wager-transaction.controller";
import { ORM_TOKEN } from "./infrastructure/tokens";
import { OutboxPublisher } from "./messaging/outbox-publisher";
import { SqsQueues } from "./messaging/sqs-queues";
import { WagerConsumer } from "./messaging/wager-consumer";
import { ApplicationMetrics } from "./observability/metrics";
import { MetricsController } from "./observability/metrics.controller";

@Module({
  controllers: [
    HealthController,
    MetricsController,
    WalletController,
    WagerTransactionController,
  ],
  providers: [
    {
      provide: ORM_TOKEN,
      useFactory: async () => {
        const orm = new MikroORM(createMikroOrmConfig());
        await orm.connect();
        return orm;
      },
    },
    { provide: ApplicationMetrics, useClass: ApplicationMetrics },
    { provide: SqsQueues, useFactory: () => new SqsQueues() },
    {
      provide: OutboxRepository,
      useFactory: (orm: MikroORM) => new OutboxRepository(orm.em),
      inject: [ORM_TOKEN],
    },
    {
      provide: InboxRepository,
      useFactory: (orm: MikroORM) => new InboxRepository(orm.em),
      inject: [ORM_TOKEN],
    },
    {
      provide: WalletRepository,
      useFactory: (orm: MikroORM, outbox: OutboxRepository) =>
        new WalletRepository(orm.em, outbox),
      inject: [ORM_TOKEN, OutboxRepository],
    },
    {
      provide: WalletLedgerRepository,
      useFactory: (orm: MikroORM) => new WalletLedgerRepository(orm.em),
      inject: [ORM_TOKEN],
    },
    {
      provide: WagerTransactionRepository,
      useFactory: (orm: MikroORM) => new WagerTransactionRepository(orm.em),
      inject: [ORM_TOKEN],
    },
    {
      provide: ProcessPersistedWagerTransaction,
      useFactory: (
        orm: MikroORM,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: WalletLedgerRepository,
        outbox: OutboxRepository,
        metrics: ApplicationMetrics,
      ) => new ProcessPersistedWagerTransaction(
        orm.em,
        wallets,
        transactions,
        ledger,
        outbox,
        metrics,
      ),
      inject: [
        ORM_TOKEN,
        WalletRepository,
        WagerTransactionRepository,
        WalletLedgerRepository,
        OutboxRepository,
        ApplicationMetrics,
      ],
    },
    {
      provide: WagerTransactionRequest,
      useFactory: (
        processor: ProcessPersistedWagerTransaction,
        metrics: ApplicationMetrics,
      ) => new WagerTransactionRequest(processor, metrics),
      inject: [ProcessPersistedWagerTransaction, ApplicationMetrics],
    },
    {
      provide: OutboxPublisher,
      useFactory: (
        orm: MikroORM,
        outbox: OutboxRepository,
        queues: SqsQueues,
        metrics: ApplicationMetrics,
      ) => new OutboxPublisher(orm, outbox, queues, metrics),
      inject: [ORM_TOKEN, OutboxRepository, SqsQueues, ApplicationMetrics],
    },
    {
      provide: WagerConsumer,
      useFactory: (
        orm: MikroORM,
        inbox: InboxRepository,
        requests: WagerTransactionRequest,
        queues: SqsQueues,
        metrics: ApplicationMetrics,
      ) => new WagerConsumer(orm, inbox, requests, queues, metrics),
      inject: [
        ORM_TOKEN,
        InboxRepository,
        WagerTransactionRequest,
        SqsQueues,
        ApplicationMetrics,
      ],
    },
    {
      provide: ReferenceRetryWorker,
      useFactory: (
        transactions: WagerTransactionRepository,
        requests: WagerTransactionRequest,
        processor: ProcessPersistedWagerTransaction,
        metrics: ApplicationMetrics,
      ) => new ReferenceRetryWorker(transactions, requests, processor, metrics),
      inject: [
        WagerTransactionRepository,
        WagerTransactionRequest,
        ProcessPersistedWagerTransaction,
        ApplicationMetrics,
      ],
    },
    {
      provide: ApplicationRuntime,
      useFactory: (
        orm: MikroORM,
        queues: SqsQueues,
        publisher: OutboxPublisher,
        consumer: WagerConsumer,
        references: ReferenceRetryWorker,
      ) => new ApplicationRuntime(orm, queues, publisher, consumer, references),
      inject: [
        ORM_TOKEN,
        SqsQueues,
        OutboxPublisher,
        WagerConsumer,
        ReferenceRetryWorker,
      ],
    },
  ],
})
export class AppModule {}
