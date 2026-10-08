import { describe, expect, test } from "bun:test";
import { Money } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { ProcessLossError, processLoss } from "./process-loss";

const createdAt = new Date("2026-10-08T00:00:00.000Z");
const processedAt = new Date("2026-10-08T00:01:00.000Z");

function createLoss(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: "loss-transaction-1",
    providerId: "provider-1",
    externalTransactionId: "loss-external-1",
    idempotencyKey: "provider-1:loss-external-1",
    payloadHash: "loss-payload-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Loss,
    money: Money.from({ amount: "30.00", currency: "BRL" }),
    createdAt,
    ...overrides,
  });
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

describe("processLoss", () => {
  test("processes LOSS without changing the wallet or creating a ledger entry", () => {
    const transaction = createLoss();
    const wallet = openWallet();
    const initialVersion = wallet.version;
    const initialUpdatedAt = wallet.updatedAt;

    const result = processLoss({ transaction, wallet, processedAt });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.toString()).toBe("100.00");
    expect("ledgerEntry" in result).toBe(false);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt?.toISOString()).toBe(processedAt.toISOString());
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(initialVersion);
    expect(wallet.updatedAt).toEqual(initialUpdatedAt);
  });

  test("rejects other transaction kinds without changing either object", () => {
    const transaction = createLoss({ kind: WagerTransactionKind.Bet });
    const wallet = openWallet();

    expect(() => processLoss({ transaction, wallet, processedAt })).toThrow(ProcessLossError);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects a transaction for a different wallet or player", () => {
    const transaction = createLoss({ walletId: "another-wallet" });
    const wallet = openWallet();

    expect(() => processLoss({ transaction, wallet, processedAt })).toThrow(ProcessLossError);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects a transaction in a different currency", () => {
    const transaction = createLoss({
      money: Money.from({ amount: "30.00", currency: "USD" }),
    });
    const wallet = openWallet();

    expect(() => processLoss({ transaction, wallet, processedAt })).toThrow(ProcessLossError);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("rejects an invalid processing date without changing either object", () => {
    const transaction = createLoss();
    const wallet = openWallet();

    expect(() => processLoss({
      transaction,
      wallet,
      processedAt: new Date(Number.NaN),
    })).toThrow(ProcessLossError);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("does not process a LOSS more than once in the domain", () => {
    const transaction = createLoss();
    const wallet = openWallet();
    const props = { transaction, wallet, processedAt };

    processLoss(props);

    expect(() => processLoss(props)).toThrow(ProcessLossError);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toString()).toBe("100.00");
  });
});
