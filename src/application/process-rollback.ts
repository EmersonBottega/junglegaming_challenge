import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet, WalletError } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface ProcessRollbackProps {
  transaction: WagerTransaction;
  wallet: Wallet;
  ledgerEntryId: string;
  processedAt: Date;
  reference?: WagerTransaction;
  alreadyReversed?: boolean;
}

export type ProcessRollbackResult =
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
      failureCode:
        | FailureCode.InvalidReference
        | FailureCode.DuplicateReversal
        | FailureCode.ReversalWouldOverdraw;
    };

export class ProcessRollbackError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProcessRollbackError";
  }
}

export function processRollback(props: ProcessRollbackProps): ProcessRollbackResult {
  const {
    transaction,
    wallet,
    ledgerEntryId,
    processedAt,
    reference,
    alreadyReversed = false,
  } = props;

  if (transaction.kind !== WagerTransactionKind.Rollback) {
    throw new ProcessRollbackError(
      "Only ROLLBACK transactions can be processed by this use case",
      "INVALID_KIND",
    );
  }

  if (transaction.status !== WagerTransactionStatus.Pending) {
    throw new ProcessRollbackError(
      "Only pending ROLLBACK transactions can be processed",
      "INVALID_STATUS",
    );
  }

  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    throw new ProcessRollbackError(
      "ROLLBACK transaction does not belong to the supplied wallet",
      "WALLET_MISMATCH",
    );
  }

  if (transaction.money.currency !== wallet.currency) {
    throw new ProcessRollbackError(
      "ROLLBACK transaction currency does not match the wallet",
      "CURRENCY_MISMATCH",
    );
  }

  if (!ledgerEntryId.trim()) {
    throw new ProcessRollbackError("Ledger entry id is required", "INVALID_LEDGER_ENTRY_ID");
  }

  if (!Number.isFinite(processedAt.getTime())) {
    throw new ProcessRollbackError("Processing date is invalid", "INVALID_DATE");
  }

  if (reference === undefined) {
    transaction.markPendingReference();
    return {
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance,
    };
  }

  if (!matchesRollbackReference(transaction, reference)) {
    transaction.reject(FailureCode.InvalidReference);
    return {
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    };
  }

  if (
    reference.status === WagerTransactionStatus.Rejected ||
    reference.status === WagerTransactionStatus.Failed
  ) {
    transaction.reject(FailureCode.InvalidReference);
    return {
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReference,
    };
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    transaction.markPendingReference();
    return {
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance,
    };
  }

  if (alreadyReversed) {
    transaction.reject(FailureCode.DuplicateReversal);
    return {
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.DuplicateReversal,
    };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === undefined) {
    throw new ProcessRollbackError(
      "A valid ROLLBACK must produce a ledger entry",
      "INVALID_LEDGER_DIRECTION",
    );
  }

  try {
    const movementProps = {
      transactionId: transaction.id,
      ledgerEntryId,
      money: transaction.money,
      occurredAt: processedAt,
    };
    const ledgerEntry = direction === "CREDIT"
      ? wallet.credit(movementProps)
      : wallet.debit(movementProps);

    transaction.markProcessed(reference.id, processedAt);

    return {
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance,
      ledgerEntry,
    };
  } catch (error) {
    if (error instanceof WalletError && error.code === "INSUFFICIENT_FUNDS") {
      transaction.reject(FailureCode.ReversalWouldOverdraw);
      return {
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReversalWouldOverdraw,
      };
    }

    throw error;
  }
}

function matchesRollbackReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  return (
    reference.kind === WagerTransactionKind.Bet ||
    reference.kind === WagerTransactionKind.Win ||
    reference.kind === WagerTransactionKind.Refund
  ) &&
    reference.externalTransactionId === transaction.referenceExternalTransactionId &&
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId &&
    reference.money.currency === transaction.money.currency &&
    reference.money.equals(transaction.money);
}
