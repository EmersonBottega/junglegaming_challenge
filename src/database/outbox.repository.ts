import type { EntityManager } from "@mikro-orm/postgresql";
import { IntegrationEvent } from "../domain/integration-event";

export interface ClaimedOutboxMessage {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
  correlation_id?: string;
  transaction_id?: string;
  provider_id?: string;
}

export class OutboxRepository {
  private readonly schema: string;

  constructor(private readonly entityManager: EntityManager) {
    const schema = entityManager.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("Outbox repository schema name is invalid");
    }

    this.schema = `"${schema}"`;
  }

  async enqueue(
    event: IntegrationEvent<unknown>,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    const envelope = event.toJSON();
    await entityManager.execute(
      `INSERT INTO ${this.schema}.outbox_message
        (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, ?, 0, ?)`,
      [
        envelope.eventId,
        envelope.aggregateId,
        envelope.eventType,
        JSON.stringify(envelope),
        event.occurredAt,
        event.occurredAt,
      ],
    );
  }

  async claimDue(
    owner: string,
    batchSize: number,
    leaseSeconds: number,
    entityManager: EntityManager = this.entityManager,
  ): Promise<ClaimedOutboxMessage[]> {
    return entityManager.execute<ClaimedOutboxMessage[]>(
      `WITH due AS (
         SELECT id
         FROM ${this.schema}.outbox_message
         WHERE published_at IS NULL
           AND next_attempt_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY occurred_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT ?
       )
       UPDATE ${this.schema}.outbox_message AS outbox
       SET lease_owner = ?,
           lease_expires_at = now() + make_interval(secs => ?)
       FROM due
       WHERE outbox.id = due.id
       RETURNING outbox.id, outbox.aggregate_id, outbox.event_type,
                 outbox.payload, outbox.attempts,
                 outbox.payload->>'correlationId' AS correlation_id,
                 outbox.payload->'data'->>'transactionId' AS transaction_id,
                 outbox.payload->'data'->>'providerId' AS provider_id`,
      [batchSize, owner, leaseSeconds],
    );
  }

  async markPublished(
    id: string,
    owner: string,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    const [updated] = await entityManager.execute<{ id: string }[]>(
      `UPDATE ${this.schema}.outbox_message
       SET published_at = now(), lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND lease_owner = ? AND published_at IS NULL
       RETURNING id`,
      [id, owner],
    );
    if (!updated) {
      throw new Error(`Outbox message ${id} is no longer leased by ${owner}`);
    }
  }

  async scheduleRetry(
    id: string,
    owner: string,
    delaySeconds: number,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    const [updated] = await entityManager.execute<{ id: string }[]>(
      `UPDATE ${this.schema}.outbox_message
       SET attempts = attempts + 1,
           next_attempt_at = now() + make_interval(secs => ?),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = ? AND lease_owner = ? AND published_at IS NULL
       RETURNING id`,
      [delaySeconds, id, owner],
    );
    if (!updated) {
      throw new Error(`Outbox message ${id} is no longer leased by ${owner}`);
    }
  }

  async oldestPendingLagSeconds(
    entityManager: EntityManager = this.entityManager,
  ): Promise<number> {
    const [row] = await entityManager.execute<{ lag_seconds: string | number | null }[]>(
      `SELECT COALESCE(
         EXTRACT(EPOCH FROM (now() - min(occurred_at)))::text,
         '0'
       ) AS lag_seconds
       FROM ${this.schema}.outbox_message
       WHERE published_at IS NULL`,
    );
    const lag = Number(row?.lag_seconds ?? 0);
    if (!Number.isFinite(lag) || lag < 0) {
      throw new Error("Outbox query returned an invalid lag value");
    }
    return lag;
  }
}
