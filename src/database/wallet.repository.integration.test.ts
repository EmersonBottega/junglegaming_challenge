import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { WalletRepository } from "./wallet.repository";
import { createMikroOrmConfig } from "./mikro-orm.config";
import { WalletLedgerRepository } from "./wallet-ledger.repository";
import { WagerTransactionRepository } from "./wager-transaction.repository";
import { OutboxRepository } from "./outbox.repository";
import { ProcessPersistedWagerTransaction } from "../application/process-persisted-wager-transaction";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction";

describe("WalletRepository with PostgreSQL", () => {
  let orm: MikroORM;
  let schema: string;
  let repository: WalletRepository;
  let ledger: WalletLedgerRepository;
  let transactions: WagerTransactionRepository;
  let processor: ProcessPersistedWagerTransaction;

  beforeAll(async () => {
    schema = `wallet_repository_test_${crypto.randomUUID().replaceAll("-", "")}`;
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
    repository = new WalletRepository(orm.em);
    ledger = new WalletLedgerRepository(orm.em);
    transactions = new WagerTransactionRepository(orm.em);
    processor = new ProcessPersistedWagerTransaction(
      orm.em,
      repository,
      transactions,
      ledger,
      new OutboxRepository(orm.em),
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

  test("opens and reloads a wallet with zero balance without an opening ledger entry", async () => {
    const walletId = crypto.randomUUID();
    const opened = await repository.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.zero("BRL"),
    });

    const reloaded = await repository.findById(walletId);

    expect(reloaded?.balance.toString()).toBe("0.00");
    expect(reloaded?.version).toBe(opened.version);
    expect(await countRows("wager_transaction", walletId)).toBe(0);
    expect(await countRows("wallet_ledger_entry", walletId)).toBe(0);
    expect(await countOutboxEvents(walletId)).toBe(0);
  });

  test("persists wallet, opening transaction, and ledger entry atomically", async () => {
    const walletId = crypto.randomUUID();
    const openingTransactionId = crypto.randomUUID();
    const openingLedgerEntryId = crypto.randomUUID();
    const opened = await repository.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.from({ amount: "25.50", currency: "BRL" }),
      openingTransactionId,
      openingLedgerEntryId,
    });

    const reloaded = await repository.findById(walletId);
    const [opening] = await orm.em.getConnection().execute(
      `SELECT kind, status, amount_cents, result_balance_cents
       FROM "${schema}".wager_transaction WHERE id = ?`,
      [openingTransactionId],
    );
    const [entry] = await orm.em.getConnection().execute(
      `SELECT direction, amount_cents, balance_before_cents, balance_after_cents
       FROM "${schema}".wallet_ledger_entry WHERE id = ?`,
      [openingLedgerEntryId],
    );

    expect(opened.balance.toString()).toBe("25.50");
    expect(reloaded?.balance.toString()).toBe("25.50");
    expect(opening.kind).toBe("OPENING");
    expect(opening.status).toBe("PROCESSED");
    expect(String(opening.amount_cents)).toBe("2550");
    expect(String(opening.result_balance_cents)).toBe("2550");
    expect(entry.direction).toBe("CREDIT");
    expect(String(entry.amount_cents)).toBe("2550");
    expect(String(entry.balance_before_cents)).toBe("0");
    expect(String(entry.balance_after_cents)).toBe("2550");
    expect(await countOutboxEvents(walletId, "WagerTransactionProcessed")).toBe(1);
    expect(await countOutboxEvents(walletId, "WalletBalanceChanged")).toBe(1);
    const [balanceEvent] = await orm.em.getConnection().execute(
      `SELECT payload->'data'->>'walletVersion' AS wallet_version,
              payload->'data'->'money'->>'amount' AS amount
       FROM "${schema}".outbox_message
       WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'`,
      [walletId],
    );
    expect(balanceEvent.wallet_version).toBe("1");
    expect(balanceEvent.amount).toBe("25.50");
  });

  test("round-trips balances beyond JavaScript's safe integer range exactly", async () => {
    const walletId = crypto.randomUUID();
    const amount = "90071992547409.93";

    await repository.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.from({ amount, currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
    });

    const reloaded = await repository.findById(walletId);
    expect(reloaded?.balance.toString()).toBe(amount);
  });

  test("rolls back wallet, opening transaction, and ledger when wallet creation fails", async () => {
    const playerId = `duplicate-player-${crypto.randomUUID()}`;
    const existingWalletId = crypto.randomUUID();
    await repository.open({
      id: existingWalletId,
      playerId,
      initialBalance: Money.zero("BRL"),
    });

    const attemptedWalletId = crypto.randomUUID();
    const attemptedTransactionId = crypto.randomUUID();
    await expect(
      repository.open({
        id: attemptedWalletId,
        playerId,
        initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
        openingTransactionId: attemptedTransactionId,
        openingLedgerEntryId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();

    expect(await repository.findById(attemptedWalletId)).toBeUndefined();
    expect(await countRows("wager_transaction", attemptedWalletId)).toBe(0);
    expect(await countRows("wallet_ledger_entry", attemptedWalletId)).toBe(0);
    expect(await countOutboxEvents(attemptedWalletId)).toBe(0);
  });

  test("returns undefined when the wallet id does not exist", async () => {
    expect(await repository.findById(crypto.randomUUID())).toBeUndefined();
  });

  test("lists ledger entries with a stable cursor and reconciles against the stored balance", async () => {
    const walletId = crypto.randomUUID();
    const openedAt = new Date();
    await repository.open({
      id: walletId,
      playerId: `player-${walletId}`,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
      createdAt: openedAt,
    });
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: "test-provider",
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "ledger-pagination",
      walletId,
      playerId: `player-${walletId}`,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      createdAt: new Date(openedAt.getTime() + 1000),
    });
    await processor.execute({
      transaction,
      ledgerEntryId: crypto.randomUUID(),
      processedAt: new Date(),
    });

    const firstPage = await ledger.listByWallet(walletId, 1);
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0].direction).toBe(LedgerDirection.Debit);
    expect(firstPage.entries[0].balanceAfter.toString()).toBe("90.00");
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await ledger.listByWallet(walletId, 1, firstPage.nextCursor);
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0].direction).toBe(LedgerDirection.Credit);
    expect(secondPage.nextCursor).toBeUndefined();

    const wallet = await repository.findById(walletId);
    const reconciliation = await ledger.reconcile(walletId, wallet!.balance);
    expect(reconciliation).toMatchObject({
      consistent: true,
      checkedEntries: 2,
    });
    expect(reconciliation.calculatedBalance.toString()).toBe("90.00");
    expect(reconciliation.difference.toString()).toBe("0.00");

    await orm.em.getConnection().execute(
      `UPDATE "${schema}".wallet SET balance_cents = 8000 WHERE id = ?`,
      [walletId],
    );
    const inconsistentWallet = await repository.findById(walletId);
    const mismatch = await ledger.reconcile(walletId, inconsistentWallet!.balance);
    expect(mismatch.consistent).toBe(false);
    expect(mismatch.difference.toString()).toBe("-10.00");
  });

  async function countRows(table: "wager_transaction" | "wallet_ledger_entry", walletId: string) {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count FROM "${schema}".${table} WHERE wallet_id = ?`,
      [walletId],
    );
    return Number(result.count);
  }

  async function countOutboxEvents(walletId: string, eventType?: string) {
    const [result] = await orm.em.getConnection().execute(
      `SELECT count(*)::text AS count
       FROM "${schema}".outbox_message
       WHERE aggregate_id = ?${eventType ? " AND event_type = ?" : ""}`,
      eventType ? [walletId, eventType] : [walletId],
    );
    return Number(result.count);
  }
});
