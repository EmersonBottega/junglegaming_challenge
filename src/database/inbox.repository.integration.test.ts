import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";
import { InboxRepository } from "./inbox.repository";

describe("InboxRepository with PostgreSQL", () => {
  let orm: MikroORM;
  let schema: string;
  let inbox: InboxRepository;

  beforeAll(async () => {
    schema = `inbox_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const config = createMikroOrmConfig();
    orm = new MikroORM({
      ...config,
      schema,
      migrations: { ...config.migrations, snapshotOnMigrate: false },
    });
    await orm.connect();
    await orm.em.getConnection().execute(`CREATE SCHEMA "${schema}"`);
    await orm.migrator.up({ schema });
    inbox = new InboxRepository(orm.em);
  });

  afterAll(async () => {
    try {
      await orm.migrator.down({ schema });
      await orm.em.getConnection().execute(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await orm.close(true);
    }
  });

  test("deduplicates redelivery and detects a reused message id with a different payload", async () => {
    await orm.em.transactional(async (em) => {
      expect(await inbox.receive("consumer", "message-1", "hash-1", em)).toBe("RECEIVED");
      await inbox.markProcessed("consumer", "message-1", em);
    });
    await orm.em.transactional(async (em) => {
      expect(await inbox.receive("consumer", "message-1", "hash-1", em)).toBe("DUPLICATE");
    });
    await orm.em.transactional(async (em) => {
      expect(await inbox.receive("consumer", "message-1", "hash-2", em))
        .toBe("PAYLOAD_CONFLICT");
    });

    const [row] = await orm.em.getConnection().execute(
      `SELECT payload_hash, processed_at IS NOT NULL AS processed
       FROM "${schema}".inbox_message
       WHERE consumer_name = ? AND message_id = ?`,
      ["consumer", "message-1"],
    );
    expect(row).toMatchObject({ payload_hash: "hash-1", processed: true });
  });

  test("rolls back an inbox record when downstream work aborts the transaction", async () => {
    await expect(orm.em.transactional(async (em) => {
      await inbox.receive("consumer", "message-rollback", "hash", em);
      throw new Error("simulate processor failure");
    })).rejects.toThrow("simulate processor failure");

    const [row] = await orm.em.getConnection().execute(
      `SELECT message_id FROM "${schema}".inbox_message WHERE message_id = ?`,
      ["message-rollback"],
    );
    expect(row).toBeUndefined();
  });
});
