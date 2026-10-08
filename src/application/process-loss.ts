import { Money } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";

export interface ProcessLossProps {
  transaction: WagerTransaction;
  wallet: Wallet;
  processedAt: Date;
}

export interface ProcessLossResult {
  status: WagerTransactionStatus.Processed;
  balance: Money;
}

export class ProcessLossError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProcessLossError";
  }
}

export function processLoss(props: ProcessLossProps): ProcessLossResult {
  const { transaction, wallet, processedAt } = props;

  if (transaction.kind !== WagerTransactionKind.Loss) {
    throw new ProcessLossError("Only LOSS transactions can be processed by this use case", "INVALID_KIND");
  }

  if (transaction.status !== WagerTransactionStatus.Pending) {
    throw new ProcessLossError("Only pending LOSS transactions can be processed", "INVALID_STATUS");
  }

  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    throw new ProcessLossError("LOSS transaction does not belong to the supplied wallet", "WALLET_MISMATCH");
  }

  if (transaction.money.currency !== wallet.currency) {
    throw new ProcessLossError("LOSS transaction currency does not match the wallet", "CURRENCY_MISMATCH");
  }

  if (!Number.isFinite(processedAt.getTime())) {
    throw new ProcessLossError("Processing date is invalid", "INVALID_DATE");
  }

  transaction.markProcessed(undefined, processedAt);

  return {
    status: WagerTransactionStatus.Processed,
    balance: wallet.balance,
  };
}
