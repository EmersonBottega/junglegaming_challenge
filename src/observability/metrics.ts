import { Injectable } from "@nestjs/common";

export type TransactionMetricStatus =
  | "PROCESSED"
  | "REJECTED"
  | "PENDING"
  | "PENDING_REFERENCE"
  | "FAILED"
  | "IDEMPOTENCY_CONFLICT";

@Injectable()
export class ApplicationMetrics {
  private readonly transactionCounts = new Map<TransactionMetricStatus, number>();
  private duplicateCount = 0;
  private retryCount = 0;
  private dlqCount = 0;
  private lockWaitCount = 0;
  private lockWaitMilliseconds = 0;
  private processingMilliseconds = 0;
  private processedCount = 0;
  private outboxLagSeconds = 0;
  private reconciliationMismatchCount = 0;
  private dlqVisibleCount = 0;

  recordTransaction(status: TransactionMetricStatus): void {
    this.transactionCounts.set(status, (this.transactionCounts.get(status) ?? 0) + 1);
  }

  recordDuplicate(): void {
    this.duplicateCount += 1;
  }

  recordRetry(): void {
    this.retryCount += 1;
  }

  recordDlq(): void {
    this.dlqCount += 1;
  }

  setDlqVisibleCount(count: number): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("DLQ depth must be a non-negative integer");
    }
    this.dlqVisibleCount = count;
  }

  recordLockWait(milliseconds: number): void {
    this.lockWaitMilliseconds += milliseconds;
    if (milliseconds >= 1) this.lockWaitCount += 1;
  }

  recordProcessingDuration(milliseconds: number): void {
    this.processingMilliseconds += milliseconds;
    this.processedCount += 1;
  }

  setOutboxLag(seconds: number): void {
    this.outboxLagSeconds = Math.max(0, seconds);
  }

  recordReconciliationMismatch(): void {
    this.reconciliationMismatchCount += 1;
  }

  toPrometheus(): string {
    const lines = [
      "# HELP wager_transactions_total Financial transaction outcomes",
      "# TYPE wager_transactions_total counter",
      ...[...this.transactionCounts.entries()].map(
        ([status, count]) => `wager_transactions_total{status="${status}"} ${count}`,
      ),
      "# HELP wager_idempotent_duplicates_total Duplicate requests and messages",
      "# TYPE wager_idempotent_duplicates_total counter",
      `wager_idempotent_duplicates_total ${this.duplicateCount}`,
      "# HELP wager_retries_total Transient message and outbox retries",
      "# TYPE wager_retries_total counter",
      `wager_retries_total ${this.retryCount}`,
      "# HELP wager_dlq_messages_total Messages explicitly sent to DLQ",
      "# TYPE wager_dlq_messages_total counter",
      `wager_dlq_messages_total ${this.dlqCount}`,
      "# HELP wager_dlq_messages_visible Messages currently visible in the dead-letter queue",
      "# TYPE wager_dlq_messages_visible gauge",
      `wager_dlq_messages_visible ${this.dlqVisibleCount}`,
      "# HELP wager_lock_waits_total Lock acquisition waits of at least one millisecond",
      "# TYPE wager_lock_waits_total counter",
      `wager_lock_waits_total ${this.lockWaitCount}`,
      "# HELP wager_lock_wait_duration_ms_sum Total time waiting for transaction locks",
      "# TYPE wager_lock_wait_duration_ms_sum counter",
      `wager_lock_wait_duration_ms_sum ${this.lockWaitMilliseconds}`,
      "# HELP wager_processing_duration_ms_sum Total processing latency",
      "# TYPE wager_processing_duration_ms_sum counter",
      `wager_processing_duration_ms_sum ${this.processingMilliseconds}`,
      "# HELP wager_processing_duration_ms_count Number of measured processing operations",
      "# TYPE wager_processing_duration_ms_count counter",
      `wager_processing_duration_ms_count ${this.processedCount}`,
      "# HELP wager_outbox_lag_seconds Oldest unpublished outbox age",
      "# TYPE wager_outbox_lag_seconds gauge",
      `wager_outbox_lag_seconds ${this.outboxLagSeconds}`,
      "# HELP wager_reconciliation_mismatches_total Wallet and ledger balance differences",
      "# TYPE wager_reconciliation_mismatches_total counter",
      `wager_reconciliation_mismatches_total ${this.reconciliationMismatchCount}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}

export function logStructured(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  console[level](JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  }));
}
