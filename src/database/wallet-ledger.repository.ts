import type { EntityManager } from "@mikro-orm/postgresql";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { Money } from "../domain/money";

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
}
