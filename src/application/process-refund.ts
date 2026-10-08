import { Money } from "../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface ProcessRefundProps {
  transaction: WagerTransaction;
  wallet: Wallet;
  ledgerEntryId: string;
  processedAt: Date;
  reference?: WagerTransaction;
}

export type ProcessRefundResult =
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

export class ProcessRefundError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProcessRefundError";
  }
}

export function processRefund(props: ProcessRefundProps): ProcessRefundResult {
  const { transaction, wallet, ledgerEntryId, processedAt, reference } = props;

  if (transaction.kind !== WagerTransactionKind.Refund) {
    throw new ProcessRefundError("Only REFUND transactions can be processed by this use case", "INVALID_KIND");
  }

  if (transaction.status !== WagerTransactionStatus.Pending) {
    throw new ProcessRefundError("Only pending REFUND transactions can be processed", "INVALID_STATUS");
  }

  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    throw new ProcessRefundError("REFUND transaction does not belong to the supplied wallet", "WALLET_MISMATCH");
  }

  if (transaction.money.currency !== wallet.currency) {
    throw new ProcessRefundError("REFUND transaction currency does not match the wallet", "CURRENCY_MISMATCH");
  }

  if (!ledgerEntryId.trim()) {
    throw new ProcessRefundError("Ledger entry id is required", "INVALID_LEDGER_ENTRY_ID");
  }

  if (!Number.isFinite(processedAt.getTime())) {
    throw new ProcessRefundError("Processing date is invalid", "INVALID_DATE");
  }

  if (reference === undefined) {
    transaction.markPendingReference();
    return {
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance,
    };
  }

  if (!matchesRefundReference(transaction, reference)) {
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

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === undefined) {
    throw new ProcessRefundError("A valid REFUND must produce a ledger entry", "INVALID_LEDGER_DIRECTION");
  }

  const ledgerEntry = wallet.credit({
    transactionId: transaction.id,
    ledgerEntryId,
    money: transaction.money,
    occurredAt: processedAt,
  });

  transaction.markProcessed(reference.id, processedAt);

  return {
    status: WagerTransactionStatus.Processed,
    balance: wallet.balance,
    ledgerEntry,
  };
}

function matchesRefundReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): boolean {
  return reference.kind === WagerTransactionKind.Bet &&
    reference.externalTransactionId === transaction.referenceExternalTransactionId &&
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId &&
    reference.money.currency === transaction.money.currency &&
    reference.money.equals(transaction.money);
}
