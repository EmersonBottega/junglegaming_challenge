import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import {
  ProcessPersistedWagerTransaction,
  type PersistedWagerTransactionResult,
} from "./process-persisted-wager-transaction";
import { ApplicationMetrics, logStructured } from "../observability/metrics";
import type { EntityManager } from "@mikro-orm/postgresql";

export interface WagerRequestData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export class InvalidWagerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerRequestError";
  }
}

export function parseWagerRequestData(
  value: unknown,
  idempotencyKey?: string,
): WagerRequestData {
  if (!isRecord(value) || !isRecord(value.money)) {
    throw new InvalidWagerRequestError("Request body must be an object with money");
  }
  const providerId = requiredString(value.providerId, "providerId");
  const externalTransactionId = requiredString(
    value.externalTransactionId,
    "externalTransactionId",
  );
  const key = idempotencyKey ?? requiredString(value.idempotencyKey, "idempotencyKey");
  const playerId = requiredString(value.playerId, "playerId");
  const walletId = requiredString(value.walletId, "walletId");
  const roundId = requiredString(value.roundId, "roundId");
  const gameId = requiredString(value.gameId, "gameId");
  const amount = requiredString(value.money.amount, "money.amount");
  const currency = requiredString(value.money.currency, "money.currency");
  if (!isWagerTransactionKind(value.kind)) {
    throw new InvalidWagerRequestError("Transaction kind is invalid");
  }
  if (
    value.referenceExternalTransactionId !== undefined &&
    typeof value.referenceExternalTransactionId !== "string"
  ) {
    throw new InvalidWagerRequestError("referenceExternalTransactionId must be a string");
  }
  const data: WagerRequestData = {
    providerId,
    externalTransactionId,
    idempotencyKey: key,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: value.kind,
    money: { amount, currency },
    ...(typeof value.referenceExternalTransactionId === "string"
      ? { referenceExternalTransactionId: value.referenceExternalTransactionId }
      : {}),
  };
  validateRequest(data);
  return data;
}

@Injectable()
export class WagerTransactionRequest {
  constructor(
    private readonly processor: ProcessPersistedWagerTransaction,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async submit(
    data: WagerRequestData,
    context: { correlationId?: string; occurredAt?: Date } = {},
    entityManager?: EntityManager,
  ): Promise<PersistedWagerTransactionResult> {
    validateRequest(data);
    const canonicalPayload = {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: data.money,
      referenceExternalTransactionId: data.referenceExternalTransactionId ?? null,
    };
    const payloadHash = createHash("sha256")
      .update(canonicalJson(canonicalPayload))
      .digest("hex");
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: data.idempotencyKey,
      payloadHash,
      walletId: data.walletId,
      playerId: data.playerId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: Money.from(data.money),
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      createdAt: context.occurredAt ?? new Date(),
    });

    const started = performance.now();
    let result: PersistedWagerTransactionResult;
    try {
      result = await this.processor.execute({
        transaction,
        ledgerEntryId: crypto.randomUUID(),
        processedAt: new Date(),
        correlationId: context.correlationId,
      }, entityManager);
    } finally {
      this.metrics.recordProcessingDuration(performance.now() - started);
    }
    if (result.idempotentReplay) this.metrics.recordDuplicate();
    this.metrics.recordTransaction(result.status);
    logStructured("info", "wager_transaction_result", {
      correlationId: context.correlationId ?? transaction.id,
      transactionId: result.transactionId,
      walletId: data.walletId,
      providerId: data.providerId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    });
    return result;
  }
}

export function validateRequest(data: WagerRequestData): void {
  if (!data || typeof data !== "object") {
    throw new InvalidWagerRequestError("Request body must be an object");
  }
  for (const [name, value] of Object.entries({
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new InvalidWagerRequestError(`${name} is required`);
    }
  }
  if (!Object.values(WagerTransactionKind).includes(data.kind) ||
    data.kind === WagerTransactionKind.Opening) {
    throw new InvalidWagerRequestError("Transaction kind is invalid for provider input");
  }
  if (!data.money || typeof data.money.amount !== "string" ||
    typeof data.money.currency !== "string") {
    throw new InvalidWagerRequestError("Money amount and currency are required");
  }
  let amount: Money;
  try {
    amount = Money.from(data.money);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidWagerRequestError(error.message);
    }
    throw error;
  }
  if (!amount.isPositive()) {
    throw new InvalidWagerRequestError("Transaction amount must be positive");
  }
  if (
    (data.kind === WagerTransactionKind.Refund ||
      data.kind === WagerTransactionKind.Rollback) &&
    !data.referenceExternalTransactionId?.trim()
  ) {
    throw new InvalidWagerRequestError("This transaction kind requires a reference");
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function rejectionCode(
  result: PersistedWagerTransactionResult,
): FailureCode | undefined {
  return result.status === WagerTransactionStatus.Rejected ||
    result.status === WagerTransactionStatus.Failed
    ? result.failureCode
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidWagerRequestError(`${field} is required`);
  }
  return value;
}

function isWagerTransactionKind(value: unknown): value is WagerTransactionKind {
  return typeof value === "string" &&
    Object.values(WagerTransactionKind).some((kind) => kind === value);
}
