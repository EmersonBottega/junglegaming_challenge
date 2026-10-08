import { Migration } from "@mikro-orm/migrations";

export class Migration20261008153300_WalletAndLedger extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallet (
        id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
        player_id TEXT NOT NULL CHECK (btrim(player_id) <> ''),
        currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_cents BIGINT NOT NULL CHECK (balance_cents >= 0),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallet_player_currency_unique UNIQUE (player_id, currency)
      )
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entry (
        id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
        wallet_id TEXT NOT NULL REFERENCES wallet (id) ON DELETE RESTRICT,
        transaction_id TEXT NOT NULL CHECK (btrim(transaction_id) <> ''),
        direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
        balance_before_cents BIGINT NOT NULL CHECK (balance_before_cents >= 0),
        balance_after_cents BIGINT NOT NULL CHECK (balance_after_cents >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallet_ledger_entry_balance_matches_direction CHECK (
          (direction = 'CREDIT' AND balance_after_cents = balance_before_cents + amount_cents)
          OR
          (direction = 'DEBIT' AND balance_after_cents = balance_before_cents - amount_cents)
        ),
        CONSTRAINT wallet_ledger_entry_transaction_unique UNIQUE (wallet_id, transaction_id)
      )
    `);

    this.addSql(`
      CREATE FUNCTION reject_wallet_ledger_entry_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries cannot be updated or deleted'
          USING ERRCODE = '55000';
      END;
      $function$
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entry_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entry
      FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_entry_mutation()
    `);
  }

  override down(): void {
    this.addSql("DROP TABLE wallet_ledger_entry");
    this.addSql("DROP FUNCTION reject_wallet_ledger_entry_mutation()");
    this.addSql("DROP TABLE wallet");
  }
}
