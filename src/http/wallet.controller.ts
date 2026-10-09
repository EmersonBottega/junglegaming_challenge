import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Body,
} from "@nestjs/common";
import { Money, MoneyError } from "../domain/money";
import { WalletError } from "../domain/wallet";
import { WalletRepository } from "../database/wallet.repository";
import { WalletLedgerRepository } from "../database/wallet-ledger.repository";
import { ApplicationMetrics, logStructured } from "../observability/metrics";

interface CreateWalletBody {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

@Controller("wallets")
export class WalletController {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly metrics: ApplicationMetrics,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletBody) {
    if (
      !isRecord(body) ||
      typeof body.playerId !== "string" ||
      !isRecord(body.initialBalance) ||
      typeof body.initialBalance.amount !== "string" ||
      typeof body.initialBalance.currency !== "string"
    ) {
      throw new BadRequestException("playerId and initialBalance are required");
    }
    try {
      const wallet = await this.wallets.open({
        id: crypto.randomUUID(),
        playerId: body.playerId,
        initialBalance: Money.from(body.initialBalance),
        openingTransactionId: crypto.randomUUID(),
        openingLedgerEntryId: crypto.randomUUID(),
      });
      return walletResponse(wallet);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("A wallet already exists for this player and currency");
      }
      if (error instanceof MoneyError || error instanceof WalletError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundException("Wallet was not found");
    return walletResponse(wallet);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    if (!await this.wallets.findById(walletId)) {
      throw new NotFoundException("Wallet was not found");
    }
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("limit must be an integer between 1 and 100");
    }
    try {
      const page = await this.ledger.listByWallet(walletId, limit, cursor);
      return {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Ledger cursor is invalid") {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Post(":walletId/reconciliation")
  async reconcile(@Param("walletId") walletId: string) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundException("Wallet was not found");
    const result = await this.ledger.reconcile(walletId, wallet.balance);
    if (!result.consistent) {
      this.metrics.recordReconciliationMismatch();
      logStructured("error", "wallet_reconciliation_mismatch", {
        correlationId: crypto.randomUUID(),
        walletId,
        checkedEntries: result.checkedEntries,
      });
    }
    return {
      walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}

function walletResponse(wallet: {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
