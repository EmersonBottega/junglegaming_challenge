import { describe, expect, test } from "bun:test";
import { Money } from "./money";
import { Wallet, WalletError } from "./wallet";

const createdAt = new Date("2026-10-07T00:00:00.000Z");

describe("Wallet", () => {
  test("opens with a positive balance and returns its opening ledger entry", () => {
    const result = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: "opening-transaction-1",
      openingLedgerEntryId: "opening-entry-1",
      createdAt,
    });

    expect(result.wallet.balance.toString()).toBe("100.00");
    expect(result.wallet.version).toBe(1);
    expect(result.openingEntry?.isBalanced()).toBe(true);
    expect(result.openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(result.openingEntry?.balanceAfter.toString()).toBe("100.00");
  });

  test("opens with zero balance without creating an opening ledger entry", () => {
    const result = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL"),
      createdAt,
    });

    expect(result.wallet.balance.isZero()).toBe(true);
    expect(result.wallet.version).toBe(1);
    expect(result.openingEntry).toBeUndefined();
  });

  test("rejects a negative initial balance", () => {
    expect(() => Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL").subtract(Money.from({ amount: "1.00", currency: "BRL" })),
      createdAt,
    })).toThrow(WalletError);
  });

  test("debits the balance and returns the matching ledger entry", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: "opening-transaction-1",
      openingLedgerEntryId: "opening-entry-1",
      createdAt,
    });

    const entry = wallet.debit({
      transactionId: "bet-1",
      ledgerEntryId: "bet-entry-1",
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      occurredAt: new Date("2026-10-07T00:01:00.000Z"),
    });

    expect(wallet.balance.toString()).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("70.00");
  });

  test("credits the balance and returns the matching ledger entry", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL"),
      createdAt,
    });

    const entry = wallet.credit({
      transactionId: "win-1",
      ledgerEntryId: "win-entry-1",
      money: Money.from({ amount: "30.00", currency: "BRL" }),
      occurredAt: new Date("2026-10-07T00:01:00.000Z"),
    });

    expect(wallet.balance.toString()).toBe("30.00");
    expect(wallet.version).toBe(2);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore.toString()).toBe("0.00");
    expect(entry.balanceAfter.toString()).toBe("30.00");
  });

  test("rejects an unaffordable debit without changing the wallet", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: "opening-transaction-1",
      openingLedgerEntryId: "opening-entry-1",
      createdAt,
    });

    const updatedAtBefore = wallet.updatedAt;

    expect(() => wallet.debit({
      transactionId: "bet-1",
      ledgerEntryId: "bet-entry-1",
      money: Money.from({ amount: "100.01", currency: "BRL" }),
      occurredAt: new Date("2026-10-07T00:01:00.000Z"),
    })).toThrow(WalletError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(updatedAtBefore);
  });

  test("rejects movements in a different currency without changing the wallet", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      openingTransactionId: "opening-transaction-1",
      openingLedgerEntryId: "opening-entry-1",
      createdAt,
    });

    expect(() => wallet.credit({
      transactionId: "win-1",
      ledgerEntryId: "win-entry-1",
      money: Money.from({ amount: "1.00", currency: "USD" }),
    })).toThrow(WalletError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("increments the version only when the balance changes", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL"),
      createdAt,
    });

    expect(wallet.version).toBe(1);

    wallet.credit({
      transactionId: "win-1",
      ledgerEntryId: "win-entry-1",
      money: Money.from({ amount: "0.01", currency: "BRL" }),
      occurredAt: new Date("2026-10-07T00:01:00.000Z"),
    });

    expect(wallet.version).toBe(2);
  });

  test("does not expose mutable wallet dates", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL"),
      createdAt,
    });

    const exposedDate = wallet.createdAt;
    exposedDate.setUTCFullYear(2000);

    expect(wallet.createdAt.toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });
});
