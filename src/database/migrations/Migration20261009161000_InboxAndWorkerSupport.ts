import { Migration } from "@mikro-orm/migrations";

export class Migration20261009161000_InboxAndWorkerSupport extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_message (
        consumer_name TEXT NOT NULL CHECK (btrim(consumer_name) <> ''),
        message_id TEXT NOT NULL CHECK (btrim(message_id) <> ''),
        payload_hash TEXT NOT NULL CHECK (btrim(payload_hash) <> ''),
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);
    this.addSql(`
      CREATE INDEX inbox_message_processed_idx
      ON inbox_message (processed_at)
      WHERE processed_at IS NULL
    `);
    this.addSql(`
      ALTER TABLE wager_transaction
      ADD COLUMN reference_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (reference_attempts >= 0),
      ADD COLUMN reference_next_attempt_at TIMESTAMPTZ,
      ADD COLUMN reference_expires_at TIMESTAMPTZ
    `);
    this.addSql(`
      UPDATE wager_transaction
      SET reference_next_attempt_at = now(),
          reference_expires_at = now() + interval '24 hours'
      WHERE status = 'PENDING_REFERENCE'
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE wager_transaction
      DROP COLUMN reference_expires_at,
      DROP COLUMN reference_next_attempt_at,
      DROP COLUMN reference_attempts
    `);
    this.addSql("DROP TABLE inbox_message");
  }
}
