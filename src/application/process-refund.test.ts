import { describe, expect, test } from "bun:test";
import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { LedgerDirection } from "../domain/wallet-ledger-entry";
import { ProcessRefundError, processRefund } from "./process-refund";

const createdAt = new Date("2026-10-08T00:00:00.000Z");
const processedAt = new Date("2026-10-08T00:01:00.000Z");

function createBet(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const bet = WagerTransaction.create({
    id: "bet-transaction-1",
    providerId: "provider-1",
    externalTransactionId: "bet-external-1",
    idempotencyKey: "provider-1:bet-external-1",
    payloadHash: "bet-payload-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "30.00", currency: "BRL" }),
    createdAt,
    ...overrides,
  });
  bet.markProcessed(undefined, processedAt);
  return bet;
}

function createRefund(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: "refund-transaction-1",
    providerId: "provider-1",
    externalTransactionId: "refund-external-1",
    idempotencyKey: "provider-1:refund-external-1",
    payloadHash: "refund-payload-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Refund,
    money: Money.from({ amount: "30.00", currency: "BRL" }),
    referenceExternalTransactionId: "bet-external-1",
    createdAt,
    ...overrides,
  });
}

function openWallet(): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    openingTransactionId: "opening-transaction-1",
    openingLedgerEntryId: "opening-entry-1",
    createdAt,
  }).wallet;
}

describe("processRefund", () => {
  test("credits and processes a refund matching a processed BET", () => {
    const bet = createBet();
    const transaction = createRefund();
    const wallet = openWallet();

    const result = processRefund({
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-1",
      processedAt,
      reference: bet,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the refund to be processed");
    }

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe("80.00");
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Credit);
    expect(result.ledgerEntry.money.equals(bet.money)).toBe(true);
    expect(result.ledgerEntry.isBalanced()).toBe(true);
  });

  test("leaves the refund pending when its reference has not arrived", () => {
    const transaction = createRefund();
    const wallet = openWallet();

    const result = processRefund({
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-2",
      processedAt,
    });

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(wallet.balance.toString()).toBe("50.00");
    expect(wallet.version).toBe(1);
    expect("ledgerEntry" in result).toBe(false);
  });

  test("leaves the refund pending while the matching BET is not processed", () => {
    const bet = WagerTransaction.create({
      id: "bet-transaction-1",
      providerId: "provider-1",
      externalTransactionId: "bet-external-1",
      idempotencyKey: "provider-1:bet-external-1",
      payloadHash: "bet-payload-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      createdAt,
    });
    const transaction = createRefund();
    const wallet = openWallet();

    const result = processRefund({
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-3",
      processedAt,
      reference: bet,
    });

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(wallet.balance.toString()).toBe("50.00");
  });

  test("rejects a reference that is already terminal without being processed", () => {
    const rejectedBet = WagerTransaction.rehydrate({
      id: "bet-transaction-1",
      providerId: "provider-1",
      externalTransactionId: "bet-external-1",
      idempotencyKey: "provider-1:bet-external-1",
      payloadHash: "bet-payload-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      createdAt,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    const transaction = createRefund();
    const wallet = openWallet();

    const result = processRefund({
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-rejected-bet",
      processedAt,
      reference: rejectedBet,
    });

    expect(result).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(wallet.balance.toString()).toBe("50.00");
  });

  test("rejects a reference with a different amount", () => {
    const bet = createBet({
      money: Money.from({ amount: "31.00", currency: "BRL" }),
    });
    const transaction = createRefund();
    const wallet = openWallet();

    const result = processRefund({
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-4",
      processedAt,
      reference: bet,
    });

    expect(result).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(wallet.balance.toString()).toBe("50.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects a reference from a different provider, player, wallet, or round", () => {
    for (const overrides of [
      { providerId: "another-provider" },
      { playerId: "another-player" },
      { walletId: "another-wallet" },
      { roundId: "another-round" },
    ]) {
      const bet = createBet(overrides);
      const transaction = createRefund();
      const wallet = openWallet();

      const result = processRefund({
        transaction,
        wallet,
        ledgerEntryId: "refund-entry-5",
        processedAt,
        reference: bet,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InvalidReference);
      expect(wallet.balance.toString()).toBe("50.00");
    }
  });

  test("rejects a transaction whose type is not REFUND", () => {
    const transaction = createRefund({ kind: WagerTransactionKind.Bet });
    const wallet = openWallet();

    expect(() => processRefund({
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-6",
      processedAt,
      reference: createBet(),
    })).toThrow(ProcessRefundError);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("50.00");
  });

  test("does not process a refund more than once in the domain", () => {
    const bet = createBet();
    const transaction = createRefund();
    const wallet = openWallet();
    const props = {
      transaction,
      wallet,
      ledgerEntryId: "refund-entry-7",
      processedAt,
      reference: bet,
    };

    processRefund(props);

    expect(() => processRefund(props)).toThrow(ProcessRefundError);
    expect(wallet.balance.toString()).toBe("80.00");
    expect(wallet.version).toBe(2);
  });
});
