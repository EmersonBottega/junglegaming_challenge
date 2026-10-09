import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";

describe("wallet, ledger, and transaction database migrations", () => {
  let orm: MikroORM;
  let schema: string;

  beforeAll(async () => {
    const config = createMikroOrmConfig();
    orm = new MikroORM({
      ...config,
      migrations: {
        ...config.migrations,
        snapshotOnMigrate: false,
      },
    });
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
      await insertWallet(em, walletId, `player-${walletId}`, cents);
      await connection.execute(
        `INSERT INTO "${schema}".wager_transaction
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'round', 'game', 'BET', ?, 'BRL', 'PENDING', now())`,
        [
          transactionId,
          `provider-${walletId}`,
          `external-${transactionId}`,
          `key-${transactionId}`,
          "hash",
          walletId,
          `player-${walletId}`,
          cents,
        ],
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
    const transactionId = crypto.randomUUID();

    await expect(
      orm.em.transactional(async (em) => {
        const connection = em.getConnection();
        await insertWallet(em, walletId, `player-${walletId}`, "100");
        const persistedTransactionId = await insertTransaction(em, {
          id: transactionId,
          walletId,
          playerId: `player-${walletId}`,
          amountCents: "20",
        });
        await connection.execute(
          `INSERT INTO "${schema}".wallet_ledger_entry
            (id, wallet_id, transaction_id, direction, amount_cents,
             balance_before_cents, balance_after_cents, created_at)
           VALUES (?, ?, ?, 'DEBIT', 20, 100, 90, now())`,
          [crypto.randomUUID(), walletId, persistedTransactionId],
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
        await insertWallet(em, walletId, `player-${walletId}`, "200");
        await insertTransaction(em, {
          id: transactionId,
          walletId,
          playerId: `player-${walletId}`,
          amountCents: "100",
        });

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
      await insertWallet(em, walletId, `player-${walletId}`, "100");
      const transactionId = await insertTransaction(em, {
        walletId,
        playerId: `player-${walletId}`,
        amountCents: "100",
      });
      await connection.execute(
        `INSERT INTO "${schema}".wallet_ledger_entry
          (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (?, ?, ?, 'CREDIT', 100, 0, 100, now())`,
        [ledgerId, walletId, transactionId],
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

  test("uses idempotency keys and external ids uniquely within each provider", async () => {
    const firstWalletId = crypto.randomUUID();
    const secondWalletId = crypto.randomUUID();
    const key = `same-key-${crypto.randomUUID()}`;
    const externalId = `same-external-${crypto.randomUUID()}`;

    await orm.em.transactional(async (em) => {
      await insertWallet(em, firstWalletId);
      await insertWallet(em, secondWalletId);
      await insertTransaction(em, {
        walletId: firstWalletId,
        providerId: "provider-a",
        idempotencyKey: key,
        externalTransactionId: externalId,
      });
      await insertTransaction(em, {
        walletId: secondWalletId,
        providerId: "provider-b",
        idempotencyKey: key,
        externalTransactionId: externalId,
      });
    });

    const providerId = `provider-${crypto.randomUUID()}`;
    const walletId = crypto.randomUUID();
    const uniqueKey = `key-${crypto.randomUUID()}`;
    const uniqueExternalId = `external-${crypto.randomUUID()}`;
    await insertWallet(orm.em, walletId);
    await insertTransaction(orm.em, {
      walletId,
      providerId,
      idempotencyKey: uniqueKey,
      externalTransactionId: uniqueExternalId,
    });

    await expect(
      insertTransaction(orm.em, {
        walletId,
        providerId,
        idempotencyKey: uniqueKey,
        externalTransactionId: `external-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();

    await expect(
      insertTransaction(orm.em, {
        walletId,
        providerId,
        idempotencyKey: `key-${crypto.randomUUID()}`,
        externalTransactionId: uniqueExternalId,
      }),
    ).rejects.toThrow();
  });

  test("requires external references for REFUND and ROLLBACK transactions", async () => {
    const walletId = crypto.randomUUID();
    await insertWallet(orm.em, walletId);

    for (const kind of ["REFUND", "ROLLBACK"]) {
      await expect(
        orm.em.getConnection().execute(
          `INSERT INTO "${schema}".wager_transaction
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
             status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'round', 'game', ?, 100, 'BRL', 'PENDING', now())`,
          [
            crypto.randomUUID(),
            `provider-${kind}`,
            `external-${kind}`,
            `key-${kind}`,
            "hash",
            walletId,
            `player-${walletId}`,
            kind,
          ],
        ),
      ).rejects.toThrow();
    }
  });

  test("limits a reference to one reversal of each type without restricting WIN references", async () => {
    const providerId = `provider-${crypto.randomUUID()}`;
    const walletId = crypto.randomUUID();
    const betId = crypto.randomUUID();
    const betExternalId = `bet-${crypto.randomUUID()}`;
    await insertWallet(orm.em, walletId);

    await orm.em.getConnection().execute(
      `INSERT INTO "${schema}".wager_transaction
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
         status, result_balance_cents, created_at, processed_at)
       VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round', 'game', 'BET', 100, 'BRL',
         'PROCESSED', 0, now(), now())`,
      [
        betId,
        providerId,
        betExternalId,
        `key-${crypto.randomUUID()}`,
        walletId,
        `player-${walletId}`,
      ],
    );

    for (let i = 0; i < 2; i++) {
      await orm.em.getConnection().execute(
        `INSERT INTO "${schema}".wager_transaction
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
           reference_external_transaction_id, reference_transaction_id, status, created_at)
         VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round', 'game', 'WIN', 100, 'BRL',
           ?, ?, 'PENDING', now())`,
        [
          crypto.randomUUID(),
          providerId,
          `win-${crypto.randomUUID()}`,
          `key-${crypto.randomUUID()}`,
          walletId,
          `player-${walletId}`,
          betExternalId,
          betId,
        ],
      );
    }

    const rollbackValues = [
      providerId,
      walletId,
      `player-${walletId}`,
      betExternalId,
      betId,
    ];
    const insertRollback = (externalId: string) =>
      orm.em.getConnection().execute(
        `INSERT INTO "${schema}".wager_transaction
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
           reference_external_transaction_id, reference_transaction_id, status, created_at)
         VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round', 'game', 'ROLLBACK', 100, 'BRL',
           ?, ?, 'PENDING', now())`,
        [
          crypto.randomUUID(),
          rollbackValues[0],
          externalId,
          `key-${crypto.randomUUID()}`,
          rollbackValues[1],
          rollbackValues[2],
          rollbackValues[3],
          rollbackValues[4],
        ],
      );

    await insertRollback(`rollback-${crypto.randomUUID()}`);
    await expect(insertRollback(`rollback-${crypto.randomUUID()}`)).rejects.toThrow();
  });

  test("rejects a resolved reference from another wallet or player", async () => {
    const providerId = `provider-${crypto.randomUUID()}`;
    const referencedWalletId = crypto.randomUUID();
    const otherWalletId = crypto.randomUUID();
    const referencedPlayerId = `player-${referencedWalletId}`;
    const otherPlayerId = `player-${otherWalletId}`;
    const referencedTransactionId = crypto.randomUUID();
    const referencedExternalId = `bet-${crypto.randomUUID()}`;

    await insertWallet(orm.em, referencedWalletId, referencedPlayerId);
    await insertWallet(orm.em, otherWalletId, otherPlayerId);
    await orm.em.getConnection().execute(
      `INSERT INTO "${schema}".wager_transaction
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
         status, result_balance_cents, created_at, processed_at)
       VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round', 'game', 'BET', 100, 'BRL',
         'PROCESSED', 0, now(), now())`,
      [
        referencedTransactionId,
        providerId,
        referencedExternalId,
        `key-${crypto.randomUUID()}`,
        referencedWalletId,
        referencedPlayerId,
      ],
    );

    await expect(
      orm.em.getConnection().execute(
        `INSERT INTO "${schema}".wager_transaction
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
           reference_external_transaction_id, reference_transaction_id, status, created_at)
         VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round', 'game', 'ROLLBACK', 100, 'BRL',
           ?, ?, 'PENDING', now())`,
        [
          crypto.randomUUID(),
          providerId,
          `rollback-${crypto.randomUUID()}`,
          `key-${crypto.randomUUID()}`,
          otherWalletId,
          otherPlayerId,
          referencedExternalId,
          referencedTransactionId,
        ],
      ),
    ).rejects.toThrow();
  });

  test("stores an internal OPENING transaction without provider idempotency fields", async () => {
    const walletId = crypto.randomUUID();
    await insertWallet(orm.em, walletId);
    const openingId = crypto.randomUUID();

    await orm.em.getConnection().execute(
      `INSERT INTO "${schema}".wager_transaction
        (id, wallet_id, player_id, kind, amount_cents, currency, status,
         result_balance_cents, created_at, processed_at)
       VALUES (?, ?, ?, 'OPENING', 100, 'BRL', 'PROCESSED', 100, now(), now())`,
      [openingId, walletId, `player-${walletId}`],
    );

    const [opening] = await orm.em.getConnection().execute(
      `SELECT provider_id, idempotency_key, status
       FROM "${schema}".wager_transaction WHERE id = ?`,
      [openingId],
    );
    expect(opening.provider_id).toBeNull();
    expect(opening.idempotency_key).toBeNull();
    expect(opening.status).toBe("PROCESSED");
  });

  test("requires a persisted transaction before its ledger entry", async () => {
    const walletId = crypto.randomUUID();
    await insertWallet(orm.em, walletId);

    await expect(
      orm.em.getConnection().execute(
        `INSERT INTO "${schema}".wallet_ledger_entry
          (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (?, ?, ?, 'CREDIT', 100, 0, 100, now())`,
        [crypto.randomUUID(), walletId, crypto.randomUUID()],
      ),
    ).rejects.toThrow();
  });

  async function insertWallet(
    em: typeof orm.em,
    walletId: string,
    playerId = `player-${walletId}`,
    balanceCents = "0",
  ): Promise<void> {
    await em.getConnection().execute(
      `INSERT INTO "${schema}".wallet
        (id, player_id, currency, balance_cents, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', ?, 1, now(), now())`,
      [walletId, playerId, balanceCents],
    );
  }

  async function insertTransaction(
    em: typeof orm.em,
    overrides: {
      id?: string;
      walletId: string;
      playerId?: string;
      providerId?: string;
      externalTransactionId?: string;
      idempotencyKey?: string;
      amountCents?: string;
    },
  ): Promise<string> {
    const id = overrides.id ?? crypto.randomUUID();
    const providerId = overrides.providerId ?? `provider-${crypto.randomUUID()}`;
    const externalTransactionId = overrides.externalTransactionId ?? `external-${crypto.randomUUID()}`;
    const idempotencyKey = overrides.idempotencyKey ?? `key-${crypto.randomUUID()}`;

    await em.getConnection().execute(
      `INSERT INTO "${schema}".wager_transaction
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount_cents, currency,
         status, created_at)
       VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round', 'game', 'BET', ?, 'BRL', 'PENDING', now())`,
      [
        id,
        providerId,
        externalTransactionId,
        idempotencyKey,
        overrides.walletId,
        overrides.playerId ?? `player-${overrides.walletId}`,
        overrides.amountCents ?? "100",
      ],
    );

    return id;
  }
});
