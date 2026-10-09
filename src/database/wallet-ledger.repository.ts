import type { EntityManager } from "@mikro-orm/postgresql";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { Money } from "../domain/money";
import { LedgerDirection } from "../domain/wallet-ledger-entry";

export interface WalletLedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface WalletReconciliation {
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount_cents: string | bigint;
  balance_before_cents: string | bigint;
  balance_after_cents: string | bigint;
  currency: string;
  created_at: Date | string;
}

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function moneyToCents(money: Money): string {
  const match = /^(\d+)\.(\d{2})$/.exec(money.toString());
  if (!match) {
    throw new Error("Ledger persistence requires a non-negative Money amount");
  }

  const cents = BigInt(match[1]) * 100n + BigInt(match[2]);
  if (cents > POSTGRES_BIGINT_MAX) {
    throw new Error("Ledger amount exceeds the PostgreSQL BIGINT limit");
  }

  return cents.toString();
}

export class WalletLedgerRepository {
  private readonly schema: string;

  constructor(private readonly entityManager: EntityManager) {
    const schema = entityManager.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("Wallet ledger repository schema name is invalid");
    }

    this.schema = `"${schema}"`;
  }

  async create(
    entry: WalletLedgerEntry,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    if (!entry.isBalanced()) {
      throw new Error("Cannot persist an unbalanced wallet ledger entry");
    }

    await entityManager.execute(
      `INSERT INTO ${this.schema}.wallet_ledger_entry
        (id, wallet_id, transaction_id, direction, amount_cents,
         balance_before_cents, balance_after_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        moneyToCents(entry.money),
        moneyToCents(entry.balanceBefore),
        moneyToCents(entry.balanceAfter),
        entry.createdAt,
      ],
    );
  }

  async listByWallet(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<WalletLedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Ledger page size must be between 1 and 100");
    }
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const parameters: unknown[] = decoded
      ? [walletId, decoded.createdAt, decoded.id, limit + 1]
      : [walletId, limit + 1];
    const cursorClause = decoded
      ? "AND (entry.created_at, entry.id) < (?, ?)"
      : "";
    const rows = await this.entityManager.execute<LedgerRow[]>(
      `SELECT entry.id, entry.wallet_id, entry.transaction_id, entry.direction,
              entry.amount_cents, entry.balance_before_cents, entry.balance_after_cents,
              wallet.currency, entry.created_at
       FROM ${this.schema}.wallet_ledger_entry entry
       JOIN ${this.schema}.wallet wallet ON wallet.id = entry.wallet_id
       WHERE entry.wallet_id = ? ${cursorClause}
       ORDER BY entry.created_at DESC, entry.id DESC
       LIMIT ?`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const entries = selected.map(mapLedgerRow);
    const last = selected.at(-1);
    return {
      entries,
      ...(hasMore && last
        ? { nextCursor: encodeCursor(
            new Date(last.created_at).toISOString(),
            last.id,
          ) }
        : {}),
    };
  }

  async reconcile(walletId: string, storedBalance: Money): Promise<WalletReconciliation> {
    const [row] = await this.entityManager.execute<{
      calculated_cents: string | bigint;
      checked_entries: string | number;
    }[]>(
      `SELECT
         COALESCE(SUM(
           CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END
         ), 0)::text AS calculated_cents,
         count(*)::text AS checked_entries
       FROM ${this.schema}.wallet_ledger_entry
       WHERE wallet_id = ?`,
      [walletId],
    );
    const calculatedBalance = moneyFromCents(row.calculated_cents, storedBalance.currency);
    const difference = storedBalance.subtract(calculatedBalance);
    return {
      storedBalance,
      calculatedBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: Number(row.checked_entries),
    };
  }
}

function moneyFromCents(value: string | bigint, currency: string): Money {
  const cents = BigInt(String(value));
  const absoluteCents = cents < 0n ? -cents : cents;
  const amount =
    `${absoluteCents / 100n}.${(absoluteCents % 100n).toString().padStart(2, "0")}`;
  const positive = Money.from({ amount, currency });
  return cents < 0n ? Money.zero(currency).subtract(positive) : positive;
}

function mapLedgerRow(row: LedgerRow): WalletLedgerEntry {
  const createdAt = row.created_at instanceof Date
    ? row.created_at
    : new Date(row.created_at);
  const amount = moneyFromCents(row.amount_cents, row.currency);
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: amount,
    balanceBefore: moneyFromCents(row.balance_before_cents, amount.currency),
    balanceAfter: moneyFromCents(row.balance_after_cents, amount.currency),
    createdAt,
  });
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "createdAt" in value &&
      "id" in value &&
      typeof value.createdAt === "string" &&
      Number.isFinite(new Date(value.createdAt).getTime()) &&
      typeof value.id === "string" &&
      value.id.length > 0
    ) {
      return { createdAt: value.createdAt, id: value.id };
    }
  } catch {
    // The API maps malformed cursors to a client error.
  }
  throw new Error("Ledger cursor is invalid");
}
