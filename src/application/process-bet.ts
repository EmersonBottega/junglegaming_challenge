import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  WagerTransactionError,
} from "../domain/wager-transaction";
import { Wallet, WalletError } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { Money } from "../domain/money";

export interface ProcessBetProps {
  transaction: WagerTransaction;
  wallet: Wallet;
  ledgerEntryId: string;
  processedAt: Date;
}

export type ProcessBetResult =
  | {
      status: WagerTransactionStatus.Processed;
      balance: Money;
      ledgerEntry: WalletLedgerEntry;
    }
  | {
      status: WagerTransactionStatus.Rejected;
      failureCode: FailureCode.InsufficientFunds;
    };

export class ProcessBetError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProcessBetError";
  }
}

export function processBet(props: ProcessBetProps): ProcessBetResult {
  const { transaction, wallet, ledgerEntryId, processedAt } = props;

  if (transaction.kind !== WagerTransactionKind.Bet) {
    throw new ProcessBetError("Only BET transactions can be processed by this use case", "INVALID_KIND");
  }

  if (transaction.status !== WagerTransactionStatus.Pending) {
    throw new ProcessBetError("Only pending BET transactions can be processed", "INVALID_STATUS");
  }

  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    throw new ProcessBetError("BET transaction does not belong to the supplied wallet", "WALLET_MISMATCH");
  }

  if (transaction.money.currency !== wallet.currency) {
    throw new ProcessBetError("BET transaction currency does not match the wallet", "CURRENCY_MISMATCH");
  }

  if (!ledgerEntryId.trim()) {
    throw new ProcessBetError("Ledger entry id is required", "INVALID_LEDGER_ENTRY_ID");
  }

  if (!Number.isFinite(processedAt.getTime())) {
    throw new ProcessBetError("Processing date is invalid", "INVALID_DATE");
  }

  try {
    const ledgerEntry = wallet.debit({
      transactionId: transaction.id,
      ledgerEntryId,
      money: transaction.money,
      occurredAt: processedAt,
    });

    transaction.markProcessed(undefined, processedAt);

    return {
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance,
      ledgerEntry,
    };
  } catch (error) {
    if (error instanceof WalletError && error.code === "INSUFFICIENT_FUNDS") {
      transaction.reject(FailureCode.InsufficientFunds);

      return {
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
      };
    }

    if (error instanceof WagerTransactionError) {
      throw new ProcessBetError(error.message, error.code);
    }

    throw error;
  }
}
