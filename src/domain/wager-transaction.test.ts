import { describe, expect, test } from "bun:test";
import { Money } from "./money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionError,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "./wager-transaction";
import { LedgerDirection } from "./wallet-ledger-entry";

const createdAt = new Date("2026-10-08T00:00:00.000Z");
const processedAt = new Date("2026-10-08T00:01:00.000Z");

function createTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: "transaction-1",
    providerId: "provider-1",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-1:external-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "10.00", currency: "BRL" }),
    createdAt,
    ...overrides,
  });
}

describe("WagerTransaction", () => {
  test("creates a pending transaction and preserves its payload identity", () => {
    const transaction = createTransaction();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.matchesPayload("hash-1")).toBe(true);
    expect(transaction.matchesPayload("different-hash")).toBe(false);
    expect(transaction.isTerminal()).toBe(false);
  });

  test("requires an external reference for refunds and rollbacks", () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(() => createTransaction({ kind })).toThrow(WagerTransactionError);
    }
  });

  test("rejects invalid identities and non-positive transaction amounts", () => {
    expect(() => createTransaction({ providerId: " " })).toThrow(WagerTransactionError);
    expect(() => createTransaction({
      money: Money.zero("BRL"),
    })).toThrow(WagerTransactionError);
    expect(() => createTransaction({
      money: Money.from({ amount: "1.00", currency: "BRL" }).negate(),
    })).toThrow(WagerTransactionError);
  });

  test("marks a transaction as pending reference and later processes it", () => {
    const transaction = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "external-bet-1",
    });

    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.markProcessed("internal-bet-1", processedAt);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe("internal-bet-1");
    expect(transaction.processedAt?.toISOString()).toBe(processedAt.toISOString());
    expect(transaction.isTerminal()).toBe(true);
  });

  test("requires the resolved reference id when processing a refund or rollback", () => {
    const transaction = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "external-bet-1",
    });

    expect(() => transaction.markProcessed(undefined, processedAt)).toThrow(WagerTransactionError);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test("rejects a business rule failure with a stable failure code", () => {
    const transaction = createTransaction();

    transaction.reject(FailureCode.InsufficientFunds);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.isTerminal()).toBe(true);
  });

  test("records permanent infrastructure failure separately from rejection", () => {
    const transaction = createTransaction();

    transaction.fail(FailureCode.InfrastructureFailure);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.InfrastructureFailure);
    expect(transaction.isTerminal()).toBe(true);
  });

  test("does not allow business failures to use FAILED or infrastructure failures to use REJECTED", () => {
    const rejected = createTransaction();
    const failed = createTransaction();

    expect(() => rejected.reject(FailureCode.InfrastructureFailure)).toThrow(WagerTransactionError);
    expect(() => failed.fail(FailureCode.InsufficientFunds)).toThrow(WagerTransactionError);
    expect(rejected.status).toBe(WagerTransactionStatus.Pending);
    expect(failed.status).toBe(WagerTransactionStatus.Pending);
  });

  test("does not allow transitions after a terminal state", () => {
    const processed = createTransaction();
    processed.markProcessed(undefined, processedAt);

    expect(() => processed.reject(FailureCode.InvalidReference)).toThrow(WagerTransactionError);
    expect(() => processed.fail(FailureCode.InfrastructureFailure)).toThrow(WagerTransactionError);
    expect(() => processed.markPendingReference()).toThrow(WagerTransactionError);
    expect(() => processed.markProcessed(undefined, processedAt)).toThrow(WagerTransactionError);
  });

  test("only allows a pending transaction that requires a reference to enter PENDING_REFERENCE", () => {
    const bet = createTransaction();
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "external-bet-1",
    });

    expect(() => bet.markPendingReference()).toThrow(WagerTransactionError);
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(() => refund.markPendingReference()).toThrow(WagerTransactionError);
  });

  test("returns ledger directions for balance-affecting transaction kinds", () => {
    expect(createTransaction({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor())
      .toBe(LedgerDirection.Debit);
    expect(createTransaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
    expect(createTransaction({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
    expect(createTransaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor())
      .toBeUndefined();
  });

  test("refunds a processed bet with a credit direction", () => {
    const bet = createTransaction();
    bet.markProcessed(undefined, processedAt);
    const refund = createTransaction({
      id: "refund-1",
      externalTransactionId: "external-refund-1",
      idempotencyKey: "provider-1:external-refund-1",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test("rolls back a processed bet or win in the inverse ledger direction", () => {
    const bet = createTransaction();
    bet.markProcessed(undefined, processedAt);
    const rollbackBet = createTransaction({
      id: "rollback-bet-1",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const win = createTransaction({
      id: "win-1",
      kind: WagerTransactionKind.Win,
    });
    win.markProcessed(undefined, processedAt);
    const rollbackWin = createTransaction({
      id: "rollback-win-1",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: win.externalTransactionId,
    });

    expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test("rolls back a processed refund in the inverse ledger direction", () => {
    const bet = createTransaction();
    bet.markProcessed(undefined, processedAt);
    const refund = createTransaction({
      id: "refund-1",
      externalTransactionId: "external-refund-1",
      idempotencyKey: "provider-1:external-refund-1",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    refund.markProcessed(bet.id, processedAt);
    const rollback = createTransaction({
      id: "rollback-refund-1",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: refund.externalTransactionId,
    });

    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test("rejects invalid references for refunds and rollbacks", () => {
    const pendingBet = createTransaction();
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: pendingBet.externalTransactionId,
    });

    expect(() => refund.ledgerDirectionFor(pendingBet)).toThrow(WagerTransactionError);

    const processedLoss = createTransaction({
      kind: WagerTransactionKind.Loss,
    });
    processedLoss.markProcessed(undefined, processedAt);
    const rollback = createTransaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: processedLoss.externalTransactionId,
    });

    expect(() => rollback.ledgerDirectionFor(processedLoss)).toThrow(WagerTransactionError);
  });

  test("rejects a processed transaction that does not match the external reference id", () => {
    const bet = createTransaction();
    bet.markProcessed(undefined, processedAt);
    const refund = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "a-different-external-bet",
    });

    expect(() => refund.ledgerDirectionFor(bet)).toThrow(WagerTransactionError);
  });

  test("copies dates on input and output", () => {
    const inputDate = new Date(createdAt);
    const transaction = createTransaction({ createdAt: inputDate });

    inputDate.setUTCFullYear(2000);
    const exposedDate = transaction.createdAt;
    exposedDate.setUTCFullYear(2001);

    expect(transaction.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  test("rehydrates an already persisted terminal transaction", () => {
    const transaction = WagerTransaction.rehydrate({
      id: "transaction-1",
      providerId: "provider-1",
      externalTransactionId: "external-1",
      idempotencyKey: "provider-1:external-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      createdAt,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed(undefined, processedAt)).toThrow(WagerTransactionError);
  });
});
