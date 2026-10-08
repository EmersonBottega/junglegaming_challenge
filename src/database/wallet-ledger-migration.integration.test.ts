import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";

describe("wallet and ledger database migration", () => {
  let orm: MikroORM;
  let schema: string;

  beforeAll(async () => {
    orm = new MikroORM(createMikroOrmConfig());
    await orm.connect();

    schema = `wallet_ledger_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await orm.em.getConnection().execute(`CREATE SCHEMA "${schema}"`);
    await orm.migrator.up({ schema });
  });

  afterAll(async () => {
    try {
      await orm.migrator.down({ schema });
      await orm.em.getConnection().execute(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await orm.close(true);
    }
  });

  test("stores integer cents exactly beyond JavaScript's safe integer range", async () => {
    const walletId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const cents = "9007199254740993";

    await orm.em.transactional(async (em) => {
      const connection = em.getConnection();
      await connection.execute(
        `INSERT INTO "${schema}".wallet
          (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', ?, 1, now(), now())`,
        [walletId, `player-${walletId}`, cents],
      );
      await connection.execute(
        `INSERT INTO "${schema}".wallet_ledger_entry
          (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (?, ?, ?, 'CREDIT', ?, 0, ?, now())`,
        [ledgerId, walletId, transactionId, cents, cents],
      );

      const [wallet] = await connection.execute(
        `SELECT balance_cents FROM "${schema}".wallet WHERE id = ?`,
        [walletId],
      );
      expect(String(wallet.balance_cents)).toBe(cents);
    });
  });

  test("rejects a second wallet for the same player and currency", async () => {
    const playerId = `player-${crypto.randomUUID()}`;

    await expect(
      orm.em.transactional(async (em) => {
        const connection = em.getConnection();
        await connection.execute(
          `INSERT INTO "${schema}".wallet
            (id, player_id, currency, balance_cents, version, created_at, updated_at)
           VALUES (?, ?, 'BRL', 0, 1, now(), now())`,
          [crypto.randomUUID(), playerId],
        );
        await connection.execute(
          `INSERT INTO "${schema}".wallet
            (id, player_id, currency, balance_cents, version, created_at, updated_at)
           VALUES (?, ?, 'BRL', 0, 1, now(), now())`,
          [crypto.randomUUID(), playerId],
        );
      }),
    ).rejects.toThrow();
  });

  test("rejects a negative wallet balance", async () => {
    await expect(
      orm.em.getConnection().execute(
        `INSERT INTO "${schema}".wallet
          (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', -1, 1, now(), now())`,
        [crypto.randomUUID(), `player-${crypto.randomUUID()}`],
      ),
    ).rejects.toThrow();
  });

  test("rejects a ledger entry whose balances do not match its direction and amount", async () => {
    const walletId = crypto.randomUUID();

    await expect(
      orm.em.transactional(async (em) => {
        const connection = em.getConnection();
        await connection.execute(
          `INSERT INTO "${schema}".wallet
            (id, player_id, currency, balance_cents, version, created_at, updated_at)
           VALUES (?, ?, 'BRL', 100, 1, now(), now())`,
          [walletId, `player-${walletId}`],
        );
        await connection.execute(
          `INSERT INTO "${schema}".wallet_ledger_entry
            (id, wallet_id, transaction_id, direction, amount_cents,
             balance_before_cents, balance_after_cents, created_at)
           VALUES (?, ?, ?, 'DEBIT', 20, 100, 90, now())`,
          [crypto.randomUUID(), walletId, crypto.randomUUID()],
        );
      }),
    ).rejects.toThrow();
  });

  test("allows at most one ledger entry per transaction and wallet", async () => {
    const walletId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();

    await expect(
      orm.em.transactional(async (em) => {
        const connection = em.getConnection();
        await connection.execute(
          `INSERT INTO "${schema}".wallet
            (id, player_id, currency, balance_cents, version, created_at, updated_at)
           VALUES (?, ?, 'BRL', 200, 1, now(), now())`,
          [walletId, `player-${walletId}`],
        );

        await connection.execute(
          `INSERT INTO "${schema}".wallet_ledger_entry
            (id, wallet_id, transaction_id, direction, amount_cents,
             balance_before_cents, balance_after_cents, created_at)
           VALUES (?, ?, ?, 'CREDIT', 100, 0, 100, now())`,
          [crypto.randomUUID(), walletId, transactionId],
        );
        await connection.execute(
          `INSERT INTO "${schema}".wallet_ledger_entry
            (id, wallet_id, transaction_id, direction, amount_cents,
             balance_before_cents, balance_after_cents, created_at)
           VALUES (?, ?, ?, 'CREDIT', 100, 100, 200, now())`,
          [crypto.randomUUID(), walletId, transactionId],
        );
      }),
    ).rejects.toThrow();
  });

  test("prevents ledger entries from being updated or deleted", async () => {
    const walletId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();

    const insertWalletAndLedger = async (em: typeof orm.em) => {
      const connection = em.getConnection();
      await connection.execute(
        `INSERT INTO "${schema}".wallet
          (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', 100, 1, now(), now())`,
        [walletId, `player-${walletId}`],
      );
      await connection.execute(
        `INSERT INTO "${schema}".wallet_ledger_entry
          (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (?, ?, ?, 'CREDIT', 100, 0, 100, now())`,
        [ledgerId, walletId, crypto.randomUUID()],
      );
    };

    await expect(
      orm.em.transactional(async (em) => {
        await insertWalletAndLedger(em);
        await em.getConnection().execute(
          `UPDATE "${schema}".wallet_ledger_entry SET amount_cents = 101 WHERE id = ?`,
          [ledgerId],
        );
      }),
    ).rejects.toThrow();

    await expect(
      orm.em.transactional(async (em) => {
        await insertWalletAndLedger(em);
        await em.getConnection().execute(
          `DELETE FROM "${schema}".wallet_ledger_entry WHERE id = ?`,
          [ledgerId],
        );
      }),
    ).rejects.toThrow();
  });
});
