import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { WalletRepository } from "../database/wallet.repository";
import { WalletLedgerRepository } from "../database/wallet-ledger.repository";
import { WagerTransactionRepository } from "../database/wager-transaction.repository";
import { createMikroOrmConfig } from "../database/mikro-orm.config";
import { ProcessPersistedBet } from "./process-persisted-bet";

describe("ProcessPersistedBet with PostgreSQL", () => {
  let orm: MikroORM;
  let schema: string;
  let wallets: WalletRepository;
  let transactions: WagerTransactionRepository;
  let processor: ProcessPersistedBet;

  beforeAll(async () => {
    schema = `process_bet_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const config = createMikroOrmConfig();
    orm = new MikroORM({
      ...config,
      schema,
      migrations: {
        ...config.migrations,
        snapshotOnMigrate: false,
      },
    });
    await orm.connect();
    await orm.em.getConnection().execute(`CREATE SCHEMA "${schema}"`);
    await orm.migrator.up({ schema });

    wallets = new WalletRepository(orm.em);
    transactions = new WagerTransactionRepository(orm.em);
    processor = new ProcessPersistedBet(
      orm.em,
      wallets,
      transactions,
      new WalletLedgerRepository(orm.em),
    );
  });

  afterAll(async () => {
    try {
      await orm.migrator.down({ schema });
      await orm.em.getConnection().execute(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await orm.close(true);
    }
  });

  test("allows exactly one of two concurrent 80 bets against a 100 balance", async () => {
    const wallet = await createWallet("100.00");
    const first = createBet(wallet.id, "80.00");
    const second = createBet(wallet.id, "80.00");

    const results = await Promise.all([
      process(first),
      process(second),
    ]);

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(results.find((result) => result.status === WagerTransactionStatus.Rejected)).toMatchObject({
      failureCode: FailureCode.InsufficientFunds,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("20.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countTransactions(wallet.id)).toBe(2);
  });

  test("processes fifty concurrent deliveries of one bet only once", async () => {
    const wallet = await createWallet("100.00");
    const original = createBet(wallet.id, "25.00");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => process(cloneTransaction(original))),
    );

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(50);
    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay === true)).toHaveLength(49);
    for (const result of results) {
      if (result.status === WagerTransactionStatus.Processed) {
        expect(result.balance.toString()).toBe("75.00");
      }
    }
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("75.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
    expect(await countTransactions(wallet.id)).toBe(1);
  });

  test("returns an idempotency conflict when the same key has a different payload", async () => {
    const wallet = await createWallet("100.00");
    const original = createBet(wallet.id, "25.00");
    const processed = await process(original);
    expect(processed.status).toBe(WagerTransactionStatus.Processed);

    const changed = createBet(wallet.id, "30.00", {
      providerId: original.providerId,
      idempotencyKey: original.idempotencyKey,
      externalTransactionId: original.externalTransactionId,
      payloadHash: "different-payload",
    });
    const conflict = await process(changed);

    expect(conflict).toMatchObject({
      status: "IDEMPOTENCY_CONFLICT",
      transactionId: original.id,
      idempotentReplay: false,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("75.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
  });

  test("persists insufficient funds as a rejected transaction without ledger movement", async () => {
    const wallet = await createWallet("50.00");
    const bet = createBet(wallet.id, "80.00");

    const first = await process(bet);
    const replay = await process(cloneTransaction(bet));

    expect(first).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: true,
    });
    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("50.00");
    expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
    expect(await countTransactions(wallet.id)).toBe(1);
  });

  test("rolls back the transaction and wallet update if the ledger insert fails", async () => {
    const walletId = crypto.randomUUID();
    const openingLedgerId = crypto.randomUUID();
    const wallet = await wallets.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: openingLedgerId,
    });
    const bet = createBet(wallet.id, "25.00");

    await expect(process(bet, openingLedgerId)).rejects.toThrow();

    expect((await wallets.findById(wallet.id))?.balance.toString()).toBe("100.00");
    expect(await transactions.findByIdempotencyKey(bet.providerId, bet.idempotencyKey)).toBeUndefined();
    expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
  });

  async function createWallet(initialBalance: string) {
    const id = crypto.randomUUID();
    return wallets.open({
      id,
      playerId: `player-${id}`,
      initialBalance: Money.from({ amount: initialBalance, currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
    });
  }

  function createBet(
    walletId: string,
    amount: string,
    overrides: {
      providerId?: string;
      idempotencyKey?: string;
      externalTransactionId?: string;
      payloadHash?: string;
    } = {},
  ): WagerTransaction {
    return WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: overrides.providerId ?? `provider-${crypto.randomUUID()}`,
      externalTransactionId: overrides.externalTransactionId ?? `external-${crypto.randomUUID()}`,
      idempotencyKey: overrides.idempotencyKey ?? `key-${crypto.randomUUID()}`,
      payloadHash: overrides.payloadHash ?? `payload-${crypto.randomUUID()}`,
      walletId,
      playerId: `player-${walletId}`,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount, currency: "BRL" }),
      createdAt: new Date("2026-10-09T14:00:00.000Z"),
    });
  }

  function cloneTransaction(transaction: WagerTransaction): WagerTransaction {
    return createBet(transaction.walletId, transaction.money.toString(), {
      providerId: transaction.providerId,
      idempotencyKey: transaction.idempotencyKey,
      externalTransactionId: transaction.externalTransactionId,
      payloadHash: transaction.payloadHash,
    });
  }

  function process(transaction: WagerTransaction, ledgerEntryId = crypto.randomUUID()) {
    return processor.execute({
      transaction,
      ledgerEntryId,
      processedAt: new Date("2026-10-09T14:01:00.000Z"),
    });
  }

  async function countLedger(walletId: string, direction: string): Promise<number> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wallet_ledger_entry
       WHERE wallet_id = ? AND direction = ?`,
      [walletId, direction],
    );
    return Number(result.count);
  }

  async function countTransactions(walletId: string): Promise<number> {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".wager_transaction
       WHERE wallet_id = ? AND kind = 'BET'`,
      [walletId],
    );
    return Number(result.count);
  }
});
