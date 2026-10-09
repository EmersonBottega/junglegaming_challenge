import type { EntityManager } from "@mikro-orm/postgresql";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Money } from "../domain/money";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ProcessBetError, processBet } from "./process-bet";
import { WalletRepository } from "../database/wallet.repository";
import { WalletLedgerRepository } from "../database/wallet-ledger.repository";
import { WagerTransactionRepository } from "../database/wager-transaction.repository";

export type PersistedBetResult =
  | {
      status: WagerTransactionStatus.Processed;
      transactionId: string;
      balance: Money;
      idempotentReplay: boolean;
      ledgerEntry?: WalletLedgerEntry;
    }
  | {
      status: WagerTransactionStatus.Rejected;
      transactionId: string;
      failureCode: FailureCode;
      idempotentReplay: boolean;
    }
  | {
      status: WagerTransactionStatus.Pending | WagerTransactionStatus.PendingReference;
      transactionId: string;
      idempotentReplay: true;
    }
  | {
      status: WagerTransactionStatus.Failed;
      transactionId: string;
      failureCode: FailureCode;
      idempotentReplay: true;
    }
  | {
      status: "IDEMPOTENCY_CONFLICT";
      transactionId: string;
      idempotentReplay: false;
    };

export class ProcessPersistedBet {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: WalletLedgerRepository,
  ) {}

  async execute(props: {
    transaction: WagerTransaction;
    ledgerEntryId: string;
    processedAt: Date;
  }): Promise<PersistedBetResult> {
    const { transaction } = props;

    return this.entityManager.transactional(async (em) => {
      const lockKey = `${transaction.providerId.length}:${transaction.providerId}${transaction.idempotencyKey}`;
      await em.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
        [lockKey],
      );

      const existing = await this.transactions.findByIdempotencyKey(
        transaction.providerId,
        transaction.idempotencyKey,
        em,
      );
      if (existing) {
        if (!existing.transaction.matchesPayload(transaction.payloadHash)) {
          return {
            status: "IDEMPOTENCY_CONFLICT",
            transactionId: existing.transaction.id,
            idempotentReplay: false,
          };
        }

        return this.toReplayResult(existing);
      }

      const wallet = await this.wallets.findByIdForUpdate(transaction.walletId, em);
      if (!wallet) {
        throw new ProcessBetError("Wallet does not exist", "WALLET_NOT_FOUND");
      }

      await this.transactions.create(transaction, em);

      const result = processBet({
        transaction,
        wallet,
        ledgerEntryId: props.ledgerEntryId,
        processedAt: props.processedAt,
      });

      if (result.status === WagerTransactionStatus.Rejected) {
        await this.transactions.update(transaction, undefined, em);
        return {
          status: result.status,
          transactionId: transaction.id,
          failureCode: result.failureCode,
          idempotentReplay: false,
        };
      }

      await this.transactions.update(transaction, result.balance, em);
      await this.wallets.persistBalance(wallet, em);
      await this.ledger.create(result.ledgerEntry, em);

      return {
        status: result.status,
        transactionId: transaction.id,
        balance: result.balance,
        idempotentReplay: false,
        ledgerEntry: result.ledgerEntry,
      };
    });
  }

  private toReplayResult(
    existing: NonNullable<Awaited<ReturnType<WagerTransactionRepository["findByIdempotencyKey"]>>>,
  ): PersistedBetResult {
    const { transaction, resultBalance } = existing;
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        if (!resultBalance) {
          throw new Error(`Processed transaction ${transaction.id} has no stored result balance`);
        }
        return {
          status: transaction.status,
          transactionId: transaction.id,
          balance: resultBalance,
          idempotentReplay: true,
        };
      case WagerTransactionStatus.Rejected:
        if (!transaction.failureCode) {
          throw new Error(`Rejected transaction ${transaction.id} has no failure code`);
        }
        return {
          status: transaction.status,
          transactionId: transaction.id,
          failureCode: transaction.failureCode,
          idempotentReplay: true,
        };
      case WagerTransactionStatus.Failed:
        if (!transaction.failureCode) {
          throw new Error(`Failed transaction ${transaction.id} has no failure code`);
        }
        return {
          status: transaction.status,
          transactionId: transaction.id,
          failureCode: transaction.failureCode,
          idempotentReplay: true,
        };
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.PendingReference:
        return {
          status: transaction.status,
          transactionId: transaction.id,
          idempotentReplay: true,
        };
    }
  }
}
