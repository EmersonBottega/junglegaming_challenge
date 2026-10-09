import { Migration } from "@mikro-orm/migrations";

export class Migration20261009130000_WagerTransactions extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transaction (
        id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
        provider_id TEXT,
        external_transaction_id TEXT,
        idempotency_key TEXT,
        payload_hash TEXT,
        wallet_id TEXT NOT NULL REFERENCES wallet (id) ON DELETE RESTRICT,
        player_id TEXT NOT NULL CHECK (btrim(player_id) <> ''),
        round_id TEXT,
        game_id TEXT,
        kind TEXT NOT NULL CHECK (
          kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
        currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id TEXT,
        reference_transaction_id TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        failure_code TEXT CHECK (
          failure_code IS NULL OR failure_code IN (
            'INVALID_REFERENCE',
            'REFERENCE_NOT_FOUND',
            'DUPLICATE_REVERSAL',
            'INSUFFICIENT_FUNDS',
            'REVERSAL_WOULD_OVERDRAW',
            'INFRASTRUCTURE_FAILURE'
          )
        ),
        result_balance_cents BIGINT CHECK (result_balance_cents >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT wager_transaction_provider_fields_check CHECK (
          (
            kind = 'OPENING'
            AND provider_id IS NULL
            AND external_transaction_id IS NULL
            AND idempotency_key IS NULL
            AND payload_hash IS NULL
            AND round_id IS NULL
            AND game_id IS NULL
            AND status = 'PROCESSED'
          )
          OR
          (
            kind <> 'OPENING'
            AND provider_id IS NOT NULL
            AND btrim(provider_id) <> ''
            AND external_transaction_id IS NOT NULL
            AND btrim(external_transaction_id) <> ''
            AND idempotency_key IS NOT NULL
            AND btrim(idempotency_key) <> ''
            AND payload_hash IS NOT NULL
            AND btrim(payload_hash) <> ''
            AND round_id IS NOT NULL
            AND btrim(round_id) <> ''
            AND game_id IS NOT NULL
            AND btrim(game_id) <> ''
          )
        ),
        CONSTRAINT wager_transaction_reference_fields_check CHECK (
          (
            kind IN ('REFUND', 'ROLLBACK')
            AND reference_external_transaction_id IS NOT NULL
            AND btrim(reference_external_transaction_id) <> ''
          )
          OR
          (
            kind IN ('BET', 'LOSS', 'OPENING')
            AND reference_external_transaction_id IS NULL
          )
          OR
          (
            kind = 'WIN'
            AND (
              reference_external_transaction_id IS NULL
              OR btrim(reference_external_transaction_id) <> ''
            )
          )
        ),
        CONSTRAINT wager_transaction_internal_reference_check CHECK (
          reference_transaction_id IS NULL OR kind IN ('WIN', 'REFUND', 'ROLLBACK')
        ),
        CONSTRAINT wager_transaction_terminal_fields_check CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
          AND (status = 'PROCESSED') = (processed_at IS NOT NULL)
          AND (status = 'PROCESSED') = (result_balance_cents IS NOT NULL)
        ),
        CONSTRAINT wager_transaction_opening_fields_check CHECK (
          kind <> 'OPENING'
          OR (
            reference_external_transaction_id IS NULL
            AND reference_transaction_id IS NULL
            AND failure_code IS NULL
            AND result_balance_cents IS NOT NULL
            AND processed_at IS NOT NULL
          )
        ),
        CONSTRAINT wager_transaction_processed_reference_check CHECK (
          status <> 'PROCESSED'
          OR kind NOT IN ('REFUND', 'ROLLBACK')
          OR reference_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_transaction_processed_win_reference_check CHECK (
          status <> 'PROCESSED'
          OR kind <> 'WIN'
          OR reference_external_transaction_id IS NULL
          OR reference_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_transaction_idempotency_unique
          UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transaction_external_id_unique
          UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transaction_reference_target_unique
          UNIQUE (provider_id, player_id, wallet_id, currency, round_id, id),
        CONSTRAINT wager_transaction_reference_context_fk
          FOREIGN KEY (
            provider_id,
            player_id,
            wallet_id,
            currency,
            round_id,
            reference_transaction_id
          )
          REFERENCES wager_transaction (
            provider_id,
            player_id,
            wallet_id,
            currency,
            round_id,
            id
          )
          ON DELETE RESTRICT
      )
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transaction_reference_kind_unique
      ON wager_transaction (reference_transaction_id, kind)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL
    `);

    this.addSql(`
      CREATE INDEX wager_transaction_pending_reference_idx
      ON wager_transaction (created_at)
      WHERE status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      CREATE INDEX wager_transaction_external_reference_idx
      ON wager_transaction (provider_id, reference_external_transaction_id)
      WHERE reference_external_transaction_id IS NOT NULL
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entry
      ADD CONSTRAINT wallet_ledger_entry_transaction_fk
      FOREIGN KEY (transaction_id)
      REFERENCES wager_transaction (id)
      ON DELETE RESTRICT
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE wallet_ledger_entry
      DROP CONSTRAINT wallet_ledger_entry_transaction_fk
    `);
    this.addSql("DROP INDEX wager_transaction_reference_kind_unique");
    this.addSql("DROP TABLE wager_transaction");
  }
}
