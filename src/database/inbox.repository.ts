import type { EntityManager } from "@mikro-orm/postgresql";

export class InboxRepository {
  private readonly schema: string;

  constructor(private readonly entityManager: EntityManager) {
    const schema = entityManager.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("Inbox repository schema name is invalid");
    }
    this.schema = `"${schema}"`;
  }

  async receive(
    consumerName: string,
    messageId: string,
    payloadHash: string,
    entityManager: EntityManager = this.entityManager,
  ): Promise<"RECEIVED" | "DUPLICATE" | "PAYLOAD_CONFLICT"> {
    const inserted = await entityManager.execute<{ message_id: string }[]>(
      `INSERT INTO ${this.schema}.inbox_message
        (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, now())
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [consumerName, messageId, payloadHash],
    );
    if (inserted.length > 0) {
      return "RECEIVED";
    }

    const [existing] = await entityManager.execute<{ payload_hash: string }[]>(
      `SELECT payload_hash
       FROM ${this.schema}.inbox_message
       WHERE consumer_name = ? AND message_id = ?
       FOR UPDATE`,
      [consumerName, messageId],
    );
    if (!existing) {
      throw new Error("Inbox conflict row disappeared");
    }

    return existing.payload_hash === payloadHash ? "DUPLICATE" : "PAYLOAD_CONFLICT";
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    entityManager: EntityManager = this.entityManager,
  ): Promise<void> {
    const [updated] = await entityManager.execute<{ message_id: string }[]>(
      `UPDATE ${this.schema}.inbox_message
       SET processed_at = now()
       WHERE consumer_name = ? AND message_id = ? AND processed_at IS NULL
       RETURNING message_id`,
      [consumerName, messageId],
    );
    if (!updated) {
      throw new Error(`Inbox message ${messageId} was not marked as processed`);
    }
  }
}
