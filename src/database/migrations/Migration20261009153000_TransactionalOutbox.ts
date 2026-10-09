import { Migration } from "@mikro-orm/migrations";

export class Migration20261009153000_TransactionalOutbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE outbox_message (
        id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
        aggregate_id TEXT NOT NULL CHECK (btrim(aggregate_id) <> ''),
        event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ NOT NULL,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        CONSTRAINT outbox_lease_fields_check CHECK (
          (lease_owner IS NULL) = (lease_expires_at IS NULL)
        )
      )
    `);

    this.addSql(`
      CREATE INDEX outbox_message_due_idx
      ON outbox_message (next_attempt_at, occurred_at)
      WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql("DROP TABLE outbox_message");
  }
}
