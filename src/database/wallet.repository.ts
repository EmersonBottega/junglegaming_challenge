import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import { Wallet, type OpenWalletProps } from "../domain/wallet";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../domain/integration-event";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { OutboxRepository } from "./outbox.repository";

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_cents: string | bigint;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function moneyToCents(money: Money): string {
  const match = /^(\d+)\.(\d{2})$/.exec(money.toString());
  if (!match) {
    throw new Error("Wallet persistence requires a non-negative Money amount");
  }

  const cents = BigInt(match[1]) * 100n + BigInt(match[2]);
  if (cents > POSTGRES_BIGINT_MAX) {
    throw new Error("Wallet balance exceeds the PostgreSQL BIGINT limit");
  }

  return cents.toString();
}

function moneyFromCents(value: string | bigint, currency: string): Money {
  const centsText = String(value);
  if (!/^\d+$/.test(centsText)) {
    throw new Error("Persisted wallet balance is not a non-negative integer");
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
    throw new Error(`Persisted wallet ${field} is not a valid date`);
  }

  return date;
}

export class WalletRepository {
  private readonly schema: string;
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly entityManager: EntityManager,
    outbox?: OutboxRepository,
  ) {
    this.outbox = outbox ?? new OutboxRepository(entityManager);
    const schema = entityManager.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("Wallet repository schema name is invalid");
    }

    this.schema = `"${schema}"`;
  }

  async open(props: OpenWalletProps): Promise<Wallet> {
    const { wallet, openingEntry } = Wallet.open(props);
    const balanceCents = moneyToCents(wallet.balance);

    await this.entityManager.transactional(async (em) => {
      await em.execute(
        `INSERT INTO ${this.schema}.wallet
          (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          balanceCents,
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );

      if (!openingEntry) {
        return;
      }

      await em.execute(
        `INSERT INTO ${this.schema}.wager_transaction
          (id, wallet_id, player_id, kind, amount_cents, currency, status,
           result_balance_cents, created_at, processed_at)
         VALUES (?, ?, ?, 'OPENING', ?, ?, 'PROCESSED', ?, ?, ?)`,
        [
          openingEntry.transactionId,
          wallet.id,
          wallet.playerId,
          moneyToCents(openingEntry.money),
          openingEntry.money.currency,
          balanceCents,
          openingEntry.createdAt,
          openingEntry.createdAt,
        ],
      );

      await em.execute(
        `INSERT INTO ${this.schema}.wallet_ledger_entry
          (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          openingEntry.id,
          openingEntry.walletId,
          openingEntry.transactionId,
          openingEntry.direction,
          moneyToCents(openingEntry.money),
          moneyToCents(openingEntry.balanceBefore),
          moneyToCents(openingEntry.balanceAfter),
          openingEntry.createdAt,
        ],
      );

      const eventContext = {
        correlationId: openingEntry.transactionId,
        occurredAt: openingEntry.createdAt,
      };
      await this.outbox.enqueue(
        new WagerTransactionProcessed({
          ...eventContext,
          eventId: crypto.randomUUID(),
          aggregateId: wallet.id,
          data: {
            transactionId: openingEntry.transactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: WagerTransactionKind.Opening,
            money: openingEntry.money.toJSON(),
            balance: openingEntry.balanceAfter.toJSON(),
          },
        }),
        em,
      );
      await this.outbox.enqueue(
        new WalletBalanceChanged({
          ...eventContext,
          eventId: crypto.randomUUID(),
          aggregateId: wallet.id,
          data: {
            walletId: wallet.id,
            transactionId: openingEntry.transactionId,
            direction: LedgerDirection.Credit,
            money: openingEntry.money.toJSON(),
            balanceBefore: openingEntry.balanceBefore.toJSON(),
            balanceAfter: openingEntry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        }),
        em,
      );
    });

    return wallet;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.findOneById(id);
  }

  async findByIdForUpdate(
    id: string,
    entityManager: EntityManager,
  ): Promise<Wallet | undefined> {
    return this.findOneById(id, entityManager, true);
  }

  async persistBalance(
    wallet: Wallet,
    entityManager: EntityManager,
  ): Promise<void> {
    const [updated] = await entityManager.execute<{ id: string }[]>(
      `UPDATE ${this.schema}.wallet
       SET balance_cents = ?, version = ?, updated_at = ?
       WHERE id = ?
       RETURNING id`,
      [
        moneyToCents(wallet.balance),
        wallet.version,
        wallet.updatedAt,
        wallet.id,
      ],
    );

    if (!updated) {
      throw new Error(`Wallet ${wallet.id} was not found while saving its balance`);
    }
  }

  private async findOneById(
    id: string,
    entityManager: EntityManager = this.entityManager,
    forUpdate = false,
  ): Promise<Wallet | undefined> {
    const [row] = await entityManager.execute<WalletRow[]>(
      `SELECT id, player_id, currency, balance_cents, version, created_at, updated_at
       FROM ${this.schema}.wallet
       WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [id],
    );

    if (!row) {
      return undefined;
    }

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: moneyFromCents(row.balance_cents, row.currency),
      version: row.version,
      createdAt: requiredDate(row.created_at, "created_at"),
      updatedAt: requiredDate(row.updated_at, "updated_at"),
    });
  }
}
