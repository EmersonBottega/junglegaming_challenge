import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { WalletRepository } from "./wallet.repository";
import { WagerTransactionRepository } from "./wager-transaction.repository";
import { createMikroOrmConfig } from "./mikro-orm.config";

describe("WagerTransactionRepository with PostgreSQL", () => {
  let orm: MikroORM;
  let schema: string;
  let walletRepository: WalletRepository;
  let repository: WagerTransactionRepository;

  beforeAll(async () => {
    schema = `wager_transaction_repository_test_${crypto.randomUUID().replaceAll("-", "")}`;
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

    walletRepository = new WalletRepository(orm.em);
    repository = new WagerTransactionRepository(orm.em);
  });

  afterAll(async () => {
    try {
      await orm.migrator.down({ schema });
      await orm.em.getConnection().execute(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await orm.close(true);
    }
  });

  test("creates a pending transaction and finds it by all supported keys", async () => {
    const wallet = await createWallet();
    const transaction = createTransaction(wallet.id);
    await repository.create(transaction);

    const byId = await repository.findById(transaction.id);
    const byKey = await repository.findByIdempotencyKey(
      transaction.providerId,
      transaction.idempotencyKey,
    );
    const byExternalId = await repository.findByExternalTransactionId(
      transaction.providerId,
      transaction.externalTransactionId,
    );

    for (const result of [byId, byKey, byExternalId]) {
      expect(result?.transaction.id).toBe(transaction.id);
      expect(result?.transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(result?.transaction.money.toString()).toBe("12.34");
      expect(result?.transaction.money.currency).toBe("BRL");
      expect(result?.resultBalance).toBeUndefined();
    }
  });

  test("stores processed state, resolved reference, and original result balance", async () => {
    const wallet = await createWallet();
    const providerId = `provider-${crypto.randomUUID()}`;
    const reference = createTransaction(wallet.id, {
      providerId,
      kind: WagerTransactionKind.Bet,
      amount: "10.00",
    });
    await repository.create(reference);
    reference.markProcessed(undefined, new Date("2026-10-09T12:00:00.000Z"));
    await repository.update(reference, Money.from({ amount: "90.00", currency: "BRL" }));

    const refund = createTransaction(wallet.id, {
      providerId,
      kind: WagerTransactionKind.Refund,
      amount: "10.00",
      referenceExternalTransactionId: reference.externalTransactionId,
    });
    await repository.create(refund);
    refund.markProcessed(reference.id, new Date("2026-10-09T12:01:00.000Z"));
    await repository.update(refund, Money.from({ amount: "100.00", currency: "BRL" }));

    const stored = await repository.findByIdempotencyKey(
      refund.providerId,
      refund.idempotencyKey,
    );
    expect(stored?.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(stored?.transaction.referenceTransactionId).toBe(reference.id);
    expect(stored?.transaction.processedAt?.toISOString()).toBe("2026-10-09T12:01:00.000Z");
    expect(stored?.resultBalance?.toString()).toBe("100.00");
  });

  test("persists pending-reference and rejected states with failure code", async () => {
    const wallet = await createWallet();
    const transaction = createTransaction(wallet.id, {
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "not-arrived-yet",
    });
    transaction.markPendingReference();
    await repository.create(transaction);

    const waiting = await repository.findById(transaction.id);
    expect(waiting?.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.reject(FailureCode.ReferenceNotFound);
    await repository.update(transaction);
    const rejected = await repository.findById(transaction.id);
    expect(rejected?.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected?.transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test("keeps money values exact beyond JavaScript's safe integer range", async () => {
    const wallet = await createWallet();
    const amount = "90071992547409.93";
    const transaction = createTransaction(wallet.id, { amount });
    await repository.create(transaction);

    const stored = await repository.findById(transaction.id);
    expect(stored?.transaction.money.toString()).toBe(amount);
  });

  test("relies on persistent uniqueness when the same provider repeats an idempotency key", async () => {
    const wallet = await createWallet();
    const transaction = createTransaction(wallet.id);
    await repository.create(transaction);

    const repeated = createTransaction(wallet.id, {
      providerId: transaction.providerId,
      idempotencyKey: transaction.idempotencyKey,
      externalTransactionId: `external-${crypto.randomUUID()}`,
    });
    const stored = await repository.findByIdempotencyKey(
      transaction.providerId,
      transaction.idempotencyKey,
    );
    expect(stored?.transaction.matchesPayload(transaction.payloadHash)).toBe(true);
    expect(stored?.transaction.matchesPayload(repeated.payloadHash)).toBe(false);
    await expect(repository.create(repeated)).rejects.toThrow();

    const repeatedExternalId = createTransaction(wallet.id, {
      providerId: transaction.providerId,
      idempotencyKey: `key-${crypto.randomUUID()}`,
      externalTransactionId: transaction.externalTransactionId,
    });
    await expect(repository.create(repeatedExternalId)).rejects.toThrow();
  });

  test("allows another provider to use the same idempotency key", async () => {
    const wallet = await createWallet();
    const key = `shared-key-${crypto.randomUUID()}`;

    await repository.create(createTransaction(wallet.id, {
      providerId: "provider-one",
      idempotencyKey: key,
    }));
    await repository.create(createTransaction(wallet.id, {
      providerId: "provider-two",
      idempotencyKey: key,
    }));
  });

  test("does not find a transaction for an unknown key", async () => {
    expect(await repository.findById(crypto.randomUUID())).toBeUndefined();
    expect(await repository.findByIdempotencyKey("unknown", "unknown")).toBeUndefined();
    expect(await repository.findByExternalTransactionId("unknown", "unknown")).toBeUndefined();
  });

  async function createWallet() {
    const id = crypto.randomUUID();
    return walletRepository.open({
      id,
      playerId: `player-${id}`,
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: crypto.randomUUID(),
      openingLedgerEntryId: crypto.randomUUID(),
    });
  }

  function createTransaction(
    walletId: string,
    overrides: {
      providerId?: string;
      idempotencyKey?: string;
      externalTransactionId?: string;
      kind?: WagerTransactionKind;
      amount?: string;
      referenceExternalTransactionId?: string;
    } = {},
  ): WagerTransaction {
    return WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: overrides.providerId ?? `provider-${crypto.randomUUID()}`,
      externalTransactionId: overrides.externalTransactionId ?? `external-${crypto.randomUUID()}`,
      idempotencyKey: overrides.idempotencyKey ?? `key-${crypto.randomUUID()}`,
      payloadHash: `payload-${crypto.randomUUID()}`,
      walletId,
      playerId: `player-${walletId}`,
      roundId: "round-1",
      gameId: "game-1",
      kind: overrides.kind ?? WagerTransactionKind.Bet,
      money: Money.from({ amount: overrides.amount ?? "12.34", currency: "BRL" }),
      referenceExternalTransactionId: overrides.referenceExternalTransactionId,
      createdAt: new Date("2026-10-09T11:00:00.000Z"),
    });
  }
});
