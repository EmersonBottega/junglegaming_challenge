import { describe, expect, test } from "bun:test";
import { Money } from "./money";
import {
  LedgerDirection,
  WalletLedgerEntry,
  WalletLedgerEntryError,
} from "./wallet-ledger-entry";

describe("WalletLedgerEntry", () => {
  test("creates a balanced credit entry", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "35.00", currency: "BRL" }),
      createdAt: new Date("2026-10-07T00:00:00.000Z"),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe("35.00");
  });

  test("creates a balanced debit entry", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-2",
      walletId: "wallet-1",
      transactionId: "transaction-2",
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: "8.50", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "20.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "11.50", currency: "BRL" }),
      createdAt: new Date("2026-10-07T00:00:00.000Z"),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe("11.50");
  });

  test("rejects a debit that would make the wallet balance negative", () => {
    expect(() => WalletLedgerEntry.create({
      id: "entry-3",
      walletId: "wallet-1",
      transactionId: "transaction-3",
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: "20.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceAfter: Money.zero("BRL").subtract(Money.from({ amount: "10.00", currency: "BRL" })),
      createdAt: new Date("2026-10-07T00:00:00.000Z"),
    })).toThrow(WalletLedgerEntryError);
  });

  test("rejects an entry whose balance does not match its direction and amount", () => {
    expect(() => WalletLedgerEntry.create({
      id: "entry-4",
      walletId: "wallet-1",
      transactionId: "transaction-4",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "5.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "14.00", currency: "BRL" }),
      createdAt: new Date("2026-10-07T00:00:00.000Z"),
    })).toThrow(WalletLedgerEntryError);
  });

  test("rejects zero and negative ledger amounts", () => {
    for (const money of [
      Money.zero("BRL"),
      Money.from({ amount: "1.00", currency: "BRL" }).negate(),
    ]) {
      expect(() => WalletLedgerEntry.create({
        id: "entry-5",
        walletId: "wallet-1",
        transactionId: "transaction-5",
        direction: LedgerDirection.Credit,
        money,
        balanceBefore: Money.zero("BRL"),
        balanceAfter: Money.from({ amount: "1.00", currency: "BRL" }),
        createdAt: new Date("2026-10-07T00:00:00.000Z"),
      })).toThrow(WalletLedgerEntryError);
    }
  });

  test("rejects entries with conflicting currencies", () => {
    expect(() => WalletLedgerEntry.create({
      id: "entry-6",
      walletId: "wallet-1",
      transactionId: "transaction-6",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "5.00", currency: "USD" }),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: Money.from({ amount: "5.00", currency: "BRL" }),
      createdAt: new Date("2026-10-07T00:00:00.000Z"),
    })).toThrow(WalletLedgerEntryError);
  });

  test("does not expose a mutable creation date", () => {
    const createdAt = new Date("2026-10-07T00:00:00.000Z");
    const entry = WalletLedgerEntry.create({
      id: "entry-7",
      walletId: "wallet-1",
      transactionId: "transaction-7",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "5.00", currency: "BRL" }),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: Money.from({ amount: "5.00", currency: "BRL" }),
      createdAt,
    });

    createdAt.setUTCFullYear(2000);
    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(2001);

    expect(entry.createdAt.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
