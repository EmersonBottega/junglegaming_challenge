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
import { ProcessBetError, processBet } from "./process-bet";

const createdAt = new Date("2026-10-08T00:00:00.000Z");
const processedAt = new Date("2026-10-08T00:01:00.000Z");

function createBet(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
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

describe("processBet", () => {
  test("debits the wallet and processes the transaction when funds are sufficient", () => {
    const transaction = createBet();
    const wallet = openWallet();

    const result = processBet({
      transaction,
      wallet,
      ledgerEntryId: "bet-ledger-entry-1",
      processedAt,
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) {
      throw new Error("Expected the bet to be processed");
    }

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt?.toISOString()).toBe(processedAt.toISOString());
    expect(wallet.balance.toString()).toBe("70.00");
    expect(result.balance.toString()).toBe("70.00");
    expect(result.ledgerEntry.transactionId).toBe(transaction.id);
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Debit);
    expect(result.ledgerEntry.isBalanced()).toBe(true);
  });

  test("rejects for insufficient funds without changing the wallet or creating a ledger entry", () => {
    const transaction = createBet({
      money: Money.from({ amount: "80.00", currency: "BRL" }),
    });
    const wallet = openWallet("50.00");
    const initialVersion = wallet.version;

    const result = processBet({
      transaction,
      wallet,
      ledgerEntryId: "bet-ledger-entry-2",
      processedAt,
    });

    expect(result).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe("50.00");
    expect(wallet.version).toBe(initialVersion);
    expect("ledgerEntry" in result).toBe(false);
  });

  test("rejects other transaction kinds without changing either object", () => {
    const transaction = createBet({ kind: WagerTransactionKind.Win });
    const wallet = openWallet();

    expect(() => processBet({
      transaction,
      wallet,
      ledgerEntryId: "ledger-entry-1",
      processedAt,
    })).toThrow(ProcessBetError);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects a transaction for a different wallet or player", () => {
    const transaction = createBet({ walletId: "another-wallet" });
    const wallet = openWallet();

    expect(() => processBet({
      transaction,
      wallet,
      ledgerEntryId: "ledger-entry-1",
      processedAt,
    })).toThrow(ProcessBetError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test("rejects a transaction with a different currency", () => {
    const transaction = createBet({
      money: Money.from({ amount: "30.00", currency: "USD" }),
    });
    const wallet = openWallet();

    expect(() => processBet({
      transaction,
      wallet,
      ledgerEntryId: "ledger-entry-1",
      processedAt,
    })).toThrow(ProcessBetError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test("does not process a transaction more than once in the domain", () => {
    const transaction = createBet();
    const wallet = openWallet();
    const props = {
      transaction,
      wallet,
      ledgerEntryId: "ledger-entry-1",
      processedAt,
    };

    processBet(props);

    expect(() => processBet(props)).toThrow(ProcessBetError);
    expect(wallet.balance.toString()).toBe("70.00");
    expect(wallet.version).toBe(2);
  });
});
