import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface ProcessWinProps {
  transaction: WagerTransaction;
  wallet: Wallet;
  ledgerEntryId: string;
  processedAt: Date;
  reference?: WagerTransaction;
}

export type ProcessWinResult =
  | {
      status: WagerTransactionStatus.Processed;
      balance: Money;
      ledgerEntry: WalletLedgerEntry;
    }
  | {
      status: WagerTransactionStatus.PendingReference;
      balance: Money;
    }
  | {
      status: WagerTransactionStatus.Rejected;
      failureCode: FailureCode.InvalidReference;
    };

export class ProcessWinError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProcessWinError";
  }
}

export function processWin(props: ProcessWinProps): ProcessWinResult {
  const { transaction, wallet, ledgerEntryId, processedAt, reference } = props;

  if (transaction.kind !== WagerTransactionKind.Win) {
    throw new ProcessWinError("Only WIN transactions can be processed by this use case", "INVALID_KIND");
  }

  if (transaction.status !== WagerTransactionStatus.Pending) {
    throw new ProcessWinError("Only pending WIN transactions can be processed", "INVALID_STATUS");
  }

  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    throw new ProcessWinError("WIN transaction does not belong to the supplied wallet", "WALLET_MISMATCH");
  }

  if (transaction.money.currency !== wallet.currency) {
    throw new ProcessWinError("WIN transaction currency does not match the wallet", "CURRENCY_MISMATCH");
  }

  if (!ledgerEntryId.trim()) {
    throw new ProcessWinError("Ledger entry id is required", "INVALID_LEDGER_ENTRY_ID");
  }

  if (!Number.isFinite(processedAt.getTime())) {
    throw new ProcessWinError("Processing date is invalid", "INVALID_DATE");
  }

  if (transaction.referenceExternalTransactionId === undefined && reference !== undefined) {
    throw new ProcessWinError("This WIN does not declare an external reference", "UNEXPECTED_REFERENCE");
  }

  if (transaction.referenceExternalTransactionId !== undefined && reference === undefined) {
    transaction.markPendingReference();
    return {
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance,
    };
  }

  if (reference !== undefined && !isValidWinReference(transaction, reference)) {
    transaction.reject(FailureCode.InvalidReference);
    return {
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    };
  }

  const ledgerEntry = wallet.credit({
    transactionId: transaction.id,
    ledgerEntryId,
    money: transaction.money,
    occurredAt: processedAt,
  });

  transaction.markProcessed(reference?.id, processedAt);

  return {
    status: WagerTransactionStatus.Processed,
    balance: wallet.balance,
    ledgerEntry,
  };
}

function isValidWinReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  return reference.kind === WagerTransactionKind.Bet &&
    reference.status === WagerTransactionStatus.Processed &&
    reference.externalTransactionId === transaction.referenceExternalTransactionId &&
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId &&
    reference.money.currency === transaction.money.currency;
}
