import { WagerTransactionRepository } from "../database/wager-transaction.repository";
import { ApplicationMetrics, logStructured } from "../observability/metrics";
import { ProcessPersistedWagerTransaction } from "./process-persisted-wager-transaction";
import { WagerTransactionRequest } from "./wager-transaction-request";

const MAX_REFERENCE_ATTEMPTS = 12;
const BATCH_SIZE = 50;

export class ReferenceRetryWorker {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly requests: WagerTransactionRequest,
    private readonly processor: ProcessPersistedWagerTransaction,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async processDueBatch(): Promise<number> {
    const due = await this.transactions.claimDuePendingReferences(BATCH_SIZE, 60);
    for (const item of due) {
      const transaction = item.persisted.transaction;
      if (
        item.attempts >= MAX_REFERENCE_ATTEMPTS ||
        item.expiresAt.getTime() <= Date.now()
      ) {
        const rejected = await this.processor.rejectExpiredReference(
          transaction.id,
          new Date(),
        );
        if (rejected) {
          logStructured("warn", "pending_reference_expired", {
            correlationId: transaction.id,
            transactionId: transaction.id,
            walletId: transaction.walletId,
            providerId: transaction.providerId,
            attempts: item.attempts,
          });
        }
        continue;
      }
      try {
        await this.requests.submit({
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          playerId: transaction.playerId,
          walletId: transaction.walletId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          money: transaction.money.toJSON(),
          ...(transaction.referenceExternalTransactionId
            ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
            : {}),
        });
        this.metrics.recordRetry();
      } catch (error) {
        logStructured("error", "pending_reference_retry_failed", {
          correlationId: transaction.id,
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    return due.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.processDueBatch();
        await delay(1000, signal);
      } catch (error) {
        logStructured("error", "pending_reference_worker_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        await delay(2000, signal);
      }
    }
  }
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
