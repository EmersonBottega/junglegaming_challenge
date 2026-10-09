import type { EntityManager } from "@mikro-orm/postgresql";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Money } from "../domain/money";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from "../domain/integration-event";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { processBet } from "./process-bet";
import { processWin } from "./process-win";
import { processLoss } from "./process-loss";
import { processRefund } from "./process-refund";
import { processRollback } from "./process-rollback";
import { WalletRepository } from "../database/wallet.repository";
import { WalletLedgerRepository } from "../database/wallet-ledger.repository";
import { OutboxRepository } from "../database/outbox.repository";
import { WagerTransactionRepository } from "../database/wager-transaction.repository";
import { ApplicationMetrics } from "../observability/metrics";

export type PersistedWagerTransactionResult =
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
      idempotentReplay: boolean;
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

export class ProcessPersistedWagerTransactionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProcessPersistedWagerTransactionError";
  }
}

export class ProcessPersistedWagerTransaction {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  async execute(props: {
    transaction: WagerTransaction;
    ledgerEntryId: string;
    processedAt: Date;
    correlationId?: string;
  }, transactionManager?: EntityManager): Promise<PersistedWagerTransactionResult> {
    const { transaction: requestedTransaction } = props;

    return (transactionManager ?? this.entityManager).transactional(async (em) => {
      const lockKey =
        `${requestedTransaction.providerId.length}:${requestedTransaction.providerId}` +
        requestedTransaction.idempotencyKey;
      const lockStarted = performance.now();
      await em.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
        [lockKey],
      );
      this.metrics?.recordLockWait(performance.now() - lockStarted);

      const existing = await this.transactions.findByIdempotencyKey(
        requestedTransaction.providerId,
        requestedTransaction.idempotencyKey,
        em,
      );
      let transaction = requestedTransaction;
      let retryingPendingReference = false;

      if (existing) {
        if (!existing.transaction.matchesPayload(requestedTransaction.payloadHash)) {
          return {
            status: "IDEMPOTENCY_CONFLICT",
            transactionId: existing.transaction.id,
            idempotentReplay: false,
          };
        }

        if (existing.transaction.status !== WagerTransactionStatus.PendingReference) {
          return this.toReplayResult(existing);
        }

        transaction = this.recreatePending(existing.transaction);
        retryingPendingReference = true;
      }

      const wallet = await this.wallets.findByIdForUpdate(transaction.walletId, em);
      if (!wallet) {
        throw new ProcessPersistedWagerTransactionError(
          "Wallet does not exist",
          "WALLET_NOT_FOUND",
        );
      }

      if (!existing) {
        await this.transactions.create(transaction, em);
      }

      const reference = transaction.referenceExternalTransactionId
        ? await this.transactions.findByExternalTransactionIdForUpdate(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
            em,
          )
        : undefined;
      const referenceTransaction = reference?.transaction;
      const alreadyReversed =
        referenceTransaction !== undefined &&
        (transaction.kind === WagerTransactionKind.Refund ||
          transaction.kind === WagerTransactionKind.Rollback)
          ? await this.transactions.hasReversal(
              referenceTransaction.id,
              transaction.kind,
              em,
            )
          : false;

      const result = this.process({
        transaction,
        wallet,
        reference: referenceTransaction,
        alreadyReversed,
        ledgerEntryId: props.ledgerEntryId,
        processedAt: props.processedAt,
      });

      if (result.status === WagerTransactionStatus.Processed) {
        await this.transactions.update(transaction, result.balance, em);
        if (hasLedgerEntry(result)) {
          await this.wallets.persistBalance(wallet, em);
          await this.ledger.create(result.ledgerEntry, em);
        }
        await this.outbox.enqueue(
          new WagerTransactionProcessed({
            ...this.eventContext(transaction, props),
            aggregateId: wallet.id,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: transaction.playerId,
              kind: transaction.kind,
              money: transaction.money.toJSON(),
              balance: result.balance.toJSON(),
              ...(transaction.referenceExternalTransactionId
                ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
                : {}),
            },
          }),
          em,
        );
        if (hasLedgerEntry(result)) {
          await this.outbox.enqueue(
            new WalletBalanceChanged({
              ...this.eventContext(transaction, props),
              aggregateId: wallet.id,
              data: {
                walletId: wallet.id,
                transactionId: transaction.id,
                direction: result.ledgerEntry.direction,
                money: result.ledgerEntry.money.toJSON(),
                balanceBefore: result.ledgerEntry.balanceBefore.toJSON(),
                balanceAfter: result.ledgerEntry.balanceAfter.toJSON(),
                walletVersion: wallet.version,
              },
            }),
            em,
          );
        }

        return {
          status: result.status,
          transactionId: transaction.id,
          balance: result.balance,
          idempotentReplay: false,
          ...(hasLedgerEntry(result) ? { ledgerEntry: result.ledgerEntry } : {}),
        };
      }

      await this.transactions.update(transaction, undefined, em);
      if (result.status === WagerTransactionStatus.Rejected) {
        await this.outbox.enqueue(
          new WagerTransactionRejected({
            ...this.eventContext(transaction, props),
            aggregateId: wallet.id,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: transaction.playerId,
              kind: transaction.kind,
              money: transaction.money.toJSON(),
              failureCode: result.failureCode,
            },
          }),
          em,
        );
        return {
          status: result.status,
          transactionId: transaction.id,
          failureCode: result.failureCode,
          idempotentReplay: false,
        };
      }

      await this.transactions.scheduleReferenceRetry(transaction.id, 24, em);
      if (!retryingPendingReference) {
        await this.outbox.enqueue(
          new WagerTransactionPendingReference({
            ...this.eventContext(transaction, props),
            aggregateId: wallet.id,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: transaction.playerId,
              kind: transaction.kind,
              money: transaction.money.toJSON(),
              referenceExternalTransactionId: transaction.referenceExternalTransactionId!,
            },
          }),
          em,
        );
      }
      return {
        status: result.status,
        transactionId: transaction.id,
        idempotentReplay: retryingPendingReference,
      };
    });
  }

  async rejectExpiredReference(
    transactionId: string,
    processedAt: Date,
  ): Promise<boolean> {
    return this.entityManager.transactional(async (em) => {
      const persisted = await this.transactions.findByIdForUpdate(transactionId, em);
      if (
        !persisted ||
        persisted.transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return false;
      }
      const transaction = persisted.transaction;
      transaction.reject(FailureCode.ReferenceNotFound);
      await this.transactions.update(transaction, undefined, em);
      await this.outbox.enqueue(
        new WagerTransactionRejected({
          eventId: crypto.randomUUID(),
          aggregateId: transaction.walletId,
          correlationId: transaction.id,
          causationId: transaction.id,
          occurredAt: processedAt,
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            kind: transaction.kind,
            money: transaction.money.toJSON(),
            failureCode: FailureCode.ReferenceNotFound,
          },
        }),
        em,
      );
      return true;
    });
  }

  private eventContext(
    transaction: WagerTransaction,
    props: { processedAt: Date; correlationId?: string },
  ): EventContext {
    return {
      eventId: crypto.randomUUID(),
      correlationId: props.correlationId ?? transaction.id,
      causationId: transaction.id,
      occurredAt: props.processedAt,
    };
  }

  private process(props: {
    transaction: WagerTransaction;
    wallet: NonNullable<Awaited<ReturnType<WalletRepository["findById"]>>>;
    reference?: WagerTransaction;
    alreadyReversed: boolean;
    ledgerEntryId: string;
    processedAt: Date;
  }) {
    switch (props.transaction.kind) {
      case WagerTransactionKind.Bet:
        return processBet(props);
      case WagerTransactionKind.Win:
        return processWin(props);
      case WagerTransactionKind.Loss:
        return processLoss(props);
      case WagerTransactionKind.Refund:
        return processRefund(props);
      case WagerTransactionKind.Rollback:
        return processRollback(props);
      case WagerTransactionKind.Opening:
        throw new ProcessPersistedWagerTransactionError(
          "OPENING transactions are created only when opening a wallet",
          "INVALID_KIND",
        );
    }
  }

  private toReplayResult(
    existing: NonNullable<Awaited<ReturnType<WagerTransactionRepository["findByIdempotencyKey"]>>>,
  ): PersistedWagerTransactionResult {
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

  private recreatePending(transaction: WagerTransaction): WagerTransaction {
    return WagerTransaction.create({
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      createdAt: transaction.createdAt,
    });
  }
}

function hasLedgerEntry(
  result: object,
): result is { ledgerEntry: WalletLedgerEntry } {
  return "ledgerEntry" in result && result.ledgerEntry instanceof WalletLedgerEntry;
}
