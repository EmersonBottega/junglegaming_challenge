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
import { ProcessWinError, processWin } from "./process-win";

const createdAt = new Date("2026-10-08T00:00:00.000Z");
const processedAt = new Date("2026-10-08T00:01:00.000Z");

function createWin(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: "win-transaction-1",
    providerId: "provider-1",
    externalTransactionId: "win-external-1",
    idempotencyKey: "provider-1:win-external-1",
    payloadHash: "win-payload-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Win,
    money: Money.from({ amount: "20.00", currency: "BRL" }),
    createdAt,
    ...overrides,
  });
}

function createBet(): WagerTransaction {
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
    money: Money.from({ amount: "50.00", currency: "BRL" }),
    createdAt,
  });
  bet.markProcessed(undefined, processedAt);
  return bet;
}

function openWallet(): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    openingTransactionId: "opening-transaction-1",
    openingLedgerEntryId: "opening-entry-1",
    createdAt,
  }).wallet;
}

describe("processWin", () => {
  test("credits and processes a WIN that has no reference", () => {
    const transaction = createWin();
    const wallet = openWallet();

    const result = processWin({
      transaction,
      wallet,
      ledgerEntryId: "win-entry-1",
      processedAt,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the WIN to be processed");
    }

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(wallet.balance.toString()).toBe("120.00");
    expect(result.balance.toString()).toBe("120.00");
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Credit);
    expect(result.ledgerEntry.isBalanced()).toBe(true);
  });

  test("processes a WIN with a matching processed BET reference", () => {
    const bet = createBet();
    const transaction = createWin({
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const wallet = openWallet();

    const result = processWin({
      transaction,
      wallet,
      ledgerEntryId: "win-entry-2",
      processedAt,
      reference: bet,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the WIN to be processed");
    }

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe("120.00");
    expect(result.ledgerEntry.isBalanced()).toBe(true);
  });

  test("keeps a WIN pending when its declared reference has not arrived", () => {
    const transaction = createWin({
      referenceExternalTransactionId: "bet-external-1",
    });
    const wallet = openWallet();

    const result = processWin({
      transaction,
      wallet,
      ledgerEntryId: "win-entry-3",
      processedAt,
    });

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect("ledgerEntry" in result).toBe(false);
  });

  test("rejects an incompatible reference without changing the wallet", () => {
    const bet = createBet();
    const transaction = createWin({
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const wallet = openWallet();
    const otherRoundBet = WagerTransaction.rehydrate({
      id: bet.id,
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
      payloadHash: bet.payloadHash,
      walletId: bet.walletId,
      playerId: bet.playerId,
      roundId: "another-round",
      gameId: bet.gameId,
      kind: bet.kind,
      money: bet.money,
      referenceExternalTransactionId: bet.referenceExternalTransactionId,
      createdAt: bet.createdAt,
      status: WagerTransactionStatus.Processed,
      processedAt,
    });

    const result = processWin({
      transaction,
      wallet,
      ledgerEntryId: "win-entry-4",
      processedAt,
      reference: otherRoundBet,
    });

    expect(result).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects another transaction kind without changing state", () => {
    const transaction = createWin({ kind: WagerTransactionKind.Bet });
    const wallet = openWallet();

    expect(() => processWin({
      transaction,
      wallet,
      ledgerEntryId: "win-entry-5",
      processedAt,
    })).toThrow(ProcessWinError);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects a reference supplied when the WIN did not declare one", () => {
    const transaction = createWin();
    const wallet = openWallet();

    expect(() => processWin({
      transaction,
      wallet,
      ledgerEntryId: "win-entry-6",
      processedAt,
      reference: createBet(),
    })).toThrow(ProcessWinError);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });
});
