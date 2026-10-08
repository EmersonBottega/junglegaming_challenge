import { describe, expect, test } from "bun:test";
import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { ProcessRollbackError, processRollback } from "./process-rollback";

const createdAt = new Date("2026-10-08T00:00:00.000Z");
const processedAt = new Date("2026-10-08T00:01:00.000Z");

function createReference(
  kind: WagerTransactionKind.Bet | WagerTransactionKind.Win | WagerTransactionKind.Refund,
  overrides: {
    status?: WagerTransactionStatus;
    amount?: string;
    roundId?: string;
    providerId?: string;
    playerId?: string;
    walletId?: string;
  } = {},
): WagerTransaction {
  const transaction = WagerTransaction.rehydrate({
    id: `${kind.toLowerCase()}-id`,
    providerId: overrides.providerId ?? "provider-1",
    externalTransactionId: `${kind.toLowerCase()}-external`,
    idempotencyKey: `${kind.toLowerCase()}-key`,
    payloadHash: `${kind.toLowerCase()}-hash`,
    walletId: overrides.walletId ?? "wallet-1",
    playerId: overrides.playerId ?? "player-1",
    roundId: overrides.roundId ?? "round-1",
    gameId: "game-1",
    kind,
    money: Money.from({ amount: overrides.amount ?? "30.00", currency: "BRL" }),
    createdAt,
    status: overrides.status ?? WagerTransactionStatus.Processed,
    processedAt,
  });
  return transaction;
}

function createRollback(
  reference: WagerTransaction,
  overrides: { amount?: string } = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: "rollback-transaction-1",
    providerId: "provider-1",
    externalTransactionId: "rollback-external-1",
    idempotencyKey: "provider-1:rollback-external-1",
    payloadHash: "rollback-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Rollback,
    money: Money.from({
      amount: overrides.amount ?? reference.money.toString(),
      currency: reference.money.currency,
    }),
    referenceExternalTransactionId: reference.externalTransactionId,
    createdAt,
  });
}

function openWallet(initialBalance = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: initialBalance, currency: "BRL" }),
    openingTransactionId: "opening-transaction-1",
    openingLedgerEntryId: "opening-entry-1",
    createdAt,
  }).wallet;
}

describe("processRollback", () => {
  test("credits the wallet when rolling back a processed BET", () => {
    const bet = createReference(WagerTransactionKind.Bet);
    const transaction = createRollback(bet);
    const wallet = openWallet("50.00");

    const result = processRollback({
      transaction,
      wallet,
      ledgerEntryId: "rollback-entry-1",
      processedAt,
      reference: bet,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the rollback to be processed");
    }
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe("80.00");
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Credit);
    expect(result.ledgerEntry.isBalanced()).toBe(true);
  });

  test("debits the wallet when rolling back a processed WIN", () => {
    const win = createReference(WagerTransactionKind.Win);
    const transaction = createRollback(win);
    const wallet = openWallet();

    const result = processRollback({
      transaction,
      wallet,
      ledgerEntryId: "rollback-entry-2",
      processedAt,
      reference: win,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the rollback to be processed");
    }
    expect(wallet.balance.toString()).toBe("70.00");
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Debit);
    expect(result.ledgerEntry.isBalanced()).toBe(true);
  });

  test("debits the wallet when rolling back a processed REFUND", () => {
    const refund = createReference(WagerTransactionKind.Refund);
    const transaction = createRollback(refund);
    const wallet = openWallet();

    const result = processRollback({
      transaction,
      wallet,
      ledgerEntryId: "rollback-entry-3",
      processedAt,
      reference: refund,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the rollback to be processed");
    }
    expect(wallet.balance.toString()).toBe("70.00");
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Debit);
  });

  test("waits in PENDING_REFERENCE when the reference is missing or still pending", () => {
    const processedBet = createReference(WagerTransactionKind.Bet);
    const missingReferenceRollback = createRollback(processedBet);
    const wallet = openWallet();

    const missingResult = processRollback({
      transaction: missingReferenceRollback,
      wallet,
      ledgerEntryId: "rollback-entry-4",
      processedAt,
    });
    expect(missingResult.status).toBe(WagerTransactionStatus.PendingReference);
    expect(wallet.balance.toString()).toBe("100.00");

    const pendingBet = createReference(WagerTransactionKind.Bet, {
      status: WagerTransactionStatus.Pending,
    });
    const pendingRollback = createRollback(pendingBet);
    const pendingResult = processRollback({
      transaction: pendingRollback,
      wallet,
      ledgerEntryId: "rollback-entry-5",
      processedAt,
      reference: pendingBet,
    });
    expect(pendingResult.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pendingRollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects a rollback whose amount differs from the reference", () => {
    const bet = createReference(WagerTransactionKind.Bet);
    const transaction = createRollback(bet, { amount: "29.00" });
    const wallet = openWallet();

    const result = processRollback({
      transaction,
      wallet,
      ledgerEntryId: "rollback-entry-6",
      processedAt,
      reference: bet,
    });

    expect(result).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects an inverse debit that would make the wallet balance negative", () => {
    const win = createReference(WagerTransactionKind.Win);
    const transaction = createRollback(win);
    const wallet = openWallet("10.00");

    const result = processRollback({
      transaction,
      wallet,
      ledgerEntryId: "rollback-entry-7",
      processedAt,
      reference: win,
    });

    expect(result).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalWouldOverdraw,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects a reference from a different provider, player, wallet, or round", () => {
    for (const overrides of [
      { providerId: "another-provider" },
      { playerId: "another-player" },
      { walletId: "another-wallet" },
      { roundId: "another-round" },
    ]) {
      const bet = createReference(WagerTransactionKind.Bet, overrides);
      const transaction = createRollback(bet);
      const wallet = openWallet();

      const result = processRollback({
        transaction,
        wallet,
        ledgerEntryId: "rollback-entry-8",
        processedAt,
        reference: bet,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InvalidReference);
      expect(wallet.balance.toString()).toBe("100.00");
    }
  });

  test("rejects a transaction whose type is not ROLLBACK", () => {
    const bet = createReference(WagerTransactionKind.Bet);
    const transaction = WagerTransaction.rehydrate({
      id: "not-rollback",
      providerId: "provider-1",
      externalTransactionId: "external-not-rollback",
      idempotencyKey: "not-rollback-key",
      payloadHash: "not-rollback-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: bet.money,
      referenceExternalTransactionId: bet.externalTransactionId,
      createdAt,
      status: WagerTransactionStatus.Pending,
    });
    const wallet = openWallet();

    expect(() => processRollback({
      transaction,
      wallet,
      ledgerEntryId: "rollback-entry-9",
      processedAt,
      reference: bet,
    })).toThrow(ProcessRollbackError);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });
});
