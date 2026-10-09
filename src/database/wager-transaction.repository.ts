import type { EntityManager } from "@mikro-orm/postgresql";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Money } from "../domain/money";

export interface PersistedWagerTransaction {
  transaction: WagerTransaction;
  resultBalance: Money | undefined;
  referenceAttempts?: number;
  referenceExpiresAt?: Date;
}

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount_cents: string | bigint;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  result_balance_cents: string | bigint | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function moneyToCents(money: Money): string {
  const match = /^(\d+)\.(\d{2})$/.exec(money.toString());
  if (!match) {
    throw new Error("Transaction persistence requires a non-negative Money amount");
  }

  const cents = BigInt(match[1]) * 100n + BigInt(match[2]);
  if (cents > POSTGRES_BIGINT_MAX) {
    throw new Error("Transaction amount exceeds the PostgreSQL BIGINT limit");
  }

  return cents.toString();
}

function moneyFromCents(value: string | bigint, currency: string): Money {
  const centsText = String(value);
  if (!/^\d+$/.test(centsText)) {
    throw new Error("Persisted transaction amount is not a non-negative integer");
  }

  const cents = BigInt(centsText);
  const amount = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return Money.from({ amount, currency });
}

function requiredDate(value: Date | string, field: string): Date {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      ? new Date(value)
      : undefined;

  if (!date || !Number.isFinite(date.getTime())) {
    throw new Error(`Persisted transaction ${field} is not a valid date`);
  }

  return date;
}

function optionalDate(value: Date | string | null, field: string): Date | undefined {
  return value === null ? undefined : requiredDate(value, field);
}

function assertProviderTransaction(transaction: WagerTransaction): void {
  if (transaction.kind === WagerTransactionKind.Opening) {
    throw new Error("OPENING transactions are persisted when their wallet is opened");
  }
}

export class WagerTransactionRepository {
  private readonly schema: string;

  constructor(private readonly entityManager: EntityManager) {
    const schema = entityManager.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("Wager transaction repository schema name is invalid");
    }

    this.schema = `"${schema}"`;
  }

  async create(
    transaction: WagerTransaction,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    assertProviderTransaction(transaction);
    if (
      transaction.status !== WagerTransactionStatus.Pending &&
      transaction.status !== WagerTransactionStatus.PendingReference
    ) {
      throw new Error("A new transaction must be pending");
    }
    if (transaction.referenceTransactionId || transaction.failureCode || transaction.processedAt) {
      throw new Error("A new transaction cannot contain resolved or terminal state");
    }

    await entityManager.execute(
      `INSERT INTO ${this.schema}.wager_transaction
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
         reference_external_transaction_id, reference_transaction_id, status,
         failure_code, result_balance_cents, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      this.parametersFor(transaction),
    );
  }

  async update(
    transaction: WagerTransaction,
    resultBalance?: Money,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    assertProviderTransaction(transaction);

    let resultBalanceCents: string | null = null;
    if (transaction.status === WagerTransactionStatus.Processed) {
      if (!transaction.processedAt) {
        throw new Error("A processed transaction must have a processing date");
      }
      if (!resultBalance) {
        throw new Error("A processed transaction must persist its resulting wallet balance");
      }
      if (resultBalance.currency !== transaction.money.currency || resultBalance.isNegative()) {
        throw new Error("Resulting wallet balance must be non-negative and use the transaction currency");
      }
      resultBalanceCents = moneyToCents(resultBalance);
    } else if (resultBalance !== undefined) {
      throw new Error("Only processed transactions can persist a resulting wallet balance");
    }

    const [updated] = await entityManager.execute<{ id: string }[]>(
      `WITH updated AS (
         UPDATE ${this.schema}.wager_transaction
         SET reference_transaction_id = ?,
             status = ?,
             failure_code = ?,
             result_balance_cents = ?,
             processed_at = ?
         WHERE id = ?
           AND status IN ('PENDING', 'PENDING_REFERENCE')
         RETURNING id
       )
       SELECT id FROM updated`,
      [
        transaction.referenceTransactionId ?? null,
        transaction.status,
        transaction.failureCode ?? null,
        resultBalanceCents,
        transaction.processedAt ?? null,
        transaction.id,
      ],
    );
    if (!updated) {
      throw new Error(`Wager transaction ${transaction.id} was not found or is already terminal`);
    }
  }

  async findById(
    id: string,
    entityManager: EntityManager = this.entityManager,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne("id = ?", [id], entityManager);
  }

  async findByIdForUpdate(
    id: string,
    entityManager: EntityManager,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne("id = ?", [id], entityManager, true);
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    entityManager: EntityManager = this.entityManager,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne(
      "provider_id = ? AND idempotency_key = ?",
      [providerId, idempotencyKey],
      entityManager,
    );
  }

  async findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
    entityManager: EntityManager = this.entityManager,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne(
      "provider_id = ? AND external_transaction_id = ?",
      [providerId, externalTransactionId],
      entityManager,
    );
  }

  async findByExternalTransactionIdForUpdate(
    providerId: string,
    externalTransactionId: string,
    entityManager: EntityManager,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne(
      "provider_id = ? AND external_transaction_id = ?",
      [providerId, externalTransactionId],
      entityManager,
      true,
    );
  }

  async hasReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
    entityManager: EntityManager,
  ): Promise<boolean> {
    const rows = await entityManager.execute<{ id: string }[]>(
      `SELECT id
       FROM ${this.schema}.wager_transaction
       WHERE reference_transaction_id = ? AND kind = ?
       LIMIT 1`,
      [referenceTransactionId, kind],
    );
    return rows.length > 0;
  }

  async scheduleReferenceRetry(
    transactionId: string,
    ttlHours: number,
    entityManager: EntityManager,
  ): Promise<void> {
    const [updated] = await entityManager.execute<{ id: string }[]>(
      `UPDATE ${this.schema}.wager_transaction
       SET reference_attempts = reference_attempts + 1,
           reference_next_attempt_at = now() + make_interval(
             secs => LEAST(300, power(2, LEAST(reference_attempts, 8)))::int
           ),
           reference_expires_at = COALESCE(
             reference_expires_at,
             now() + make_interval(hours => ?)
           )
       WHERE id = ? AND status = 'PENDING_REFERENCE'
       RETURNING id`,
      [ttlHours, transactionId],
    );
    if (!updated) {
      throw new Error(`Pending-reference transaction ${transactionId} was not scheduled`);
    }
  }

  async claimDuePendingReferences(
    limit: number,
    leaseSeconds = 60,
  ): Promise<Array<{
    persisted: PersistedWagerTransaction;
    attempts: number;
    expiresAt: Date;
  }>> {
    return this.entityManager.transactional(async (em) => {
      const rows = await em.execute<Array<{
        id: string;
        reference_attempts: number;
        reference_expires_at: Date | string;
      }>>(
        `WITH due AS (
           SELECT id
           FROM ${this.schema}.wager_transaction
           WHERE status = 'PENDING_REFERENCE'
             AND (reference_next_attempt_at IS NULL OR reference_next_attempt_at <= now())
           ORDER BY COALESCE(reference_next_attempt_at, created_at), id
           FOR UPDATE SKIP LOCKED
           LIMIT ?
         )
         UPDATE ${this.schema}.wager_transaction AS wager
         SET reference_next_attempt_at = now() + make_interval(secs => ?)
         FROM due
         WHERE wager.id = due.id
         RETURNING wager.id, wager.reference_attempts,
                   COALESCE(
                     wager.reference_expires_at,
                     now() + interval '24 hours'
                   ) AS reference_expires_at`,
        [limit, leaseSeconds],
      );
      const claimed = [];
      for (const row of rows) {
        const persisted = await this.findById(row.id, em);
        if (!persisted) {
          throw new Error(`Pending-reference transaction ${row.id} disappeared`);
        }
        claimed.push({
          persisted,
          attempts: row.reference_attempts,
          expiresAt: requiredDate(row.reference_expires_at, "reference_expires_at"),
        });
      }
      return claimed;
    });
  }

  private async findOne(
    predicate: string,
    parameters: unknown[],
    entityManager: EntityManager,
    forUpdate = false,
  ): Promise<PersistedWagerTransaction | undefined> {
    const [row] = await entityManager.execute<WagerTransactionRow[]>(
      `SELECT id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
              reference_external_transaction_id, reference_transaction_id, status,
              failure_code, result_balance_cents, created_at, processed_at
       FROM ${this.schema}.wager_transaction
       WHERE ${predicate}${forUpdate ? " FOR UPDATE" : ""}`,
      parameters,
    );

    if (!row) {
      return undefined;
    }

    const transaction = WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: moneyFromCents(row.amount_cents, row.currency),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      createdAt: requiredDate(row.created_at, "created_at"),
      status: row.status,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: row.failure_code ?? undefined,
      processedAt: optionalDate(row.processed_at, "processed_at"),
    });

    return {
      transaction,
      resultBalance: row.result_balance_cents === null
        ? undefined
        : moneyFromCents(row.result_balance_cents, row.currency),
    };
  }

  private parametersFor(transaction: WagerTransaction): unknown[] {
    return [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.idempotencyKey,
      transaction.payloadHash,
      transaction.walletId,
      transaction.playerId,
      transaction.roundId,
      transaction.gameId,
      transaction.kind,
      moneyToCents(transaction.money),
      transaction.money.currency,
      transaction.referenceExternalTransactionId ?? null,
      transaction.referenceTransactionId ?? null,
      transaction.status,
      transaction.failureCode ?? null,
      transaction.createdAt,
    ];
  }
}
