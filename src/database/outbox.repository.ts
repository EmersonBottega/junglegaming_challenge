import type { EntityManager } from "@mikro-orm/postgresql";
import { IntegrationEvent } from "../domain/integration-event";

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
}
