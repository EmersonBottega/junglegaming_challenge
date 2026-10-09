import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  Body,
} from "@nestjs/common";
import { MoneyError } from "../domain/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import {
  InvalidWagerRequestError,
  WagerTransactionRequest,
  parseWagerRequestData,
  type WagerRequestData,
} from "../application/wager-transaction-request";
import { ProcessPersistedWagerTransactionError } from "../application/process-persisted-wager-transaction";
import { WagerTransactionRepository } from "../database/wager-transaction.repository";
import { logStructured } from "../observability/metrics";

@Controller()
export class WagerTransactionController {
  constructor(
    private readonly requests: WagerTransactionRequest,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException("Idempotency-Key header is required");
    }
    let data: WagerRequestData;
    try {
      data = parseWagerRequestData(body, idempotencyKey);
    } catch (error) {
      if (error instanceof InvalidWagerRequestError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    let result;
    try {
      result = await this.requests.submit(data);
    } catch (error) {
      if (error instanceof InvalidWagerRequestError || error instanceof MoneyError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof ProcessPersistedWagerTransactionError) {
        if (error.code === "WALLET_NOT_FOUND") {
          throw new NotFoundException(error.message);
        }
        throw new ServiceUnavailableException(error.message);
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException("Transaction already exists");
      }
      const code = databaseErrorCode(error);
      if (isTransientDatabaseCode(code)) {
        logStructured("error", "wager_request_database_unavailable", {
          correlationId: crypto.randomUUID(),
          providerId: data.providerId,
          walletId: data.walletId,
          errorCode: code,
        });
        throw new ServiceUnavailableException("Database temporarily unavailable");
      }
      throw error;
    }
    if (result.status === "IDEMPOTENCY_CONFLICT") {
      response.status(HttpStatus.CONFLICT);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else if (
      result.status === WagerTransactionStatus.Pending ||
      result.status === WagerTransactionStatus.PendingReference
    ) {
      response.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Failed) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    } else {
      response.status(HttpStatus.OK);
    }
    return {
      transactionId: result.transactionId,
      status: result.status,
      ...(result.status === WagerTransactionStatus.Processed
        ? { balance: result.balance.toJSON() }
        : {}),
      ...("failureCode" in result && result.failureCode
        ? { failureCode: result.failureCode }
        : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    const persisted = await this.transactions.findById(transactionId);
    if (!persisted) throw new NotFoundException("Transaction was not found");
    return transactionResponse(persisted);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const persisted = await this.transactions.findByExternalTransactionId(
      providerId,
      externalTransactionId,
    );
    if (!persisted) throw new NotFoundException("Transaction was not found");
    return transactionResponse(persisted);
  }
}

function transactionResponse(persisted: {
  transaction: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { toJSON(): { amount: string; currency: string } };
    status: WagerTransactionStatus;
    failureCode?: string;
    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;
    createdAt: Date;
    processedAt?: Date;
  };
  resultBalance?: { toJSON(): { amount: string; currency: string } };
}) {
  const transaction = persisted.transaction;
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.referenceExternalTransactionId
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(persisted.resultBalance
      ? { balance: persisted.resultBalance.toJSON() }
      : {}),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt
      ? { processedAt: transaction.processedAt.toISOString() }
      : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505";
}

function databaseErrorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  if (isRecord(error) && isRecord(error.cause) && typeof error.cause.code === "string") {
    return error.cause.code;
  }
  return undefined;
}

function isTransientDatabaseCode(code: string | undefined): boolean {
  return code !== undefined && (
    code.startsWith("08") ||
    ["40001", "40P01", "53300", "55P03", "57014", "57P01", "57P02", "57P03"].includes(code) ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
