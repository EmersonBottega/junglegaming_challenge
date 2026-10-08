import { LedgerDirection } from "./wallet-ledger-entry";
import { Money } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export enum FailureCode {
  InvalidReference = "INVALID_REFERENCE",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  DuplicateReversal = "DUPLICATE_REVERSAL",
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransactionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WagerTransactionError";
  }
}

export class WagerTransaction {
  private statusValue: WagerTransactionStatus;
  private referenceTransactionIdValue?: string;
  private failureCodeValue?: FailureCode;
  private processedAtTimestamp?: number;
  private readonly createdAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();
    this.statusValue = status;
    this.referenceTransactionIdValue = referenceTransactionId;
    this.failureCodeValue = failureCode;
    this.processedAtTimestamp = processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    this.validateIdentity(props);

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new WagerTransactionError("Transaction kind is invalid", "INVALID_KIND");
    }

    if (!props.money.isPositive()) {
      throw new WagerTransactionError("Transaction amount must be positive", "INVALID_AMOUNT");
    }

    if (this.requiresReferenceKind(props.kind) && !props.referenceExternalTransactionId?.trim()) {
      throw new WagerTransactionError(
        "Refund and rollback transactions require an external reference",
        "REFERENCE_REQUIRED",
      );
    }

    if (!Number.isFinite(props.createdAt.getTime())) {
      throw new WagerTransactionError("Transaction creation date is invalid", "INVALID_DATE");
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this.statusValue;
  }

  get referenceTransactionId(): string | undefined {
    return this.referenceTransactionIdValue;
  }

  get failureCode(): FailureCode | undefined {
    return this.failureCodeValue;
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  get processedAt(): Date | undefined {
    return this.processedAtTimestamp === undefined
      ? undefined
      : new Date(this.processedAtTimestamp);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition();
    this.assertValidDate(at);

    if (this.requiresReference() && !referenceTransactionId?.trim()) {
      throw new WagerTransactionError(
        "A resolved internal reference is required to process this transaction",
        "REFERENCE_REQUIRED",
      );
    }

    if (!this.requiresReference() && referenceTransactionId !== undefined) {
      throw new WagerTransactionError(
        "This transaction kind cannot have an internal reference",
        "UNEXPECTED_REFERENCE",
      );
    }

    this.statusValue = WagerTransactionStatus.Processed;
    this.referenceTransactionIdValue = referenceTransactionId;
    this.processedAtTimestamp = at.getTime();
  }

  markPendingReference(): void {
    this.assertCanTransition();

    if (this.statusValue !== WagerTransactionStatus.Pending) {
      throw new WagerTransactionError(
        "Only a pending transaction can wait for a reference",
        "INVALID_TRANSITION",
      );
    }

    if (!this.requiresReference()) {
      throw new WagerTransactionError(
        "This transaction kind does not require a reference",
        "REFERENCE_NOT_ALLOWED",
      );
    }

    this.statusValue = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition();
    this.assertFailureCode(code);
    if (code === FailureCode.InfrastructureFailure) {
      throw new WagerTransactionError(
        "Infrastructure failures must use the FAILED status",
        "INVALID_FAILURE_CODE",
      );
    }
    this.statusValue = WagerTransactionStatus.Rejected;
    this.failureCodeValue = code;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition();
    this.assertFailureCode(code);
    if (code !== FailureCode.InfrastructureFailure) {
      throw new WagerTransactionError(
        "FAILED status is reserved for permanent infrastructure failures",
        "INVALID_FAILURE_CODE",
      );
    }
    this.statusValue = WagerTransactionStatus.Failed;
    this.failureCodeValue = code;
  }

  isTerminal(): boolean {
    return this.statusValue === WagerTransactionStatus.Processed ||
      this.statusValue === WagerTransactionStatus.Rejected ||
      this.statusValue === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.requiresReferenceKind(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        if (this.kind === WagerTransactionKind.Refund) {
          this.assertValidReference(reference, [WagerTransactionKind.Bet]);
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        this.assertValidReference(reference, [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ]);
        const referenceDirection = reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
        return referenceDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertValidReference(
    reference: WagerTransaction | undefined,
    allowedKinds: WagerTransactionKind[],
  ): asserts reference is WagerTransaction {
    if (!reference) {
      throw new WagerTransactionError("A referenced transaction is required", "REFERENCE_REQUIRED");
    }

    if (
      reference.status !== WagerTransactionStatus.Processed ||
      !allowedKinds.includes(reference.kind) ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency ||
      !reference.money.equals(this.money)
    ) {
      throw new WagerTransactionError("Referenced transaction is not valid for this operation", "INVALID_REFERENCE");
    }
  }

  private assertCanTransition(): void {
    if (this.isTerminal()) {
      throw new WagerTransactionError(
        `Cannot transition a terminal transaction in status ${this.statusValue}`,
        "TERMINAL_TRANSACTION",
      );
    }

    if (
      this.statusValue !== WagerTransactionStatus.Pending &&
      this.statusValue !== WagerTransactionStatus.PendingReference
    ) {
      throw new WagerTransactionError(
        `Cannot transition a transaction in status ${this.statusValue}`,
        "INVALID_TRANSITION",
      );
    }
  }

  private assertFailureCode(code: FailureCode): void {
    if (!Object.values(FailureCode).includes(code)) {
      throw new WagerTransactionError("Failure code is invalid", "INVALID_FAILURE_CODE");
    }
  }

  private assertValidDate(date: Date): void {
    if (!Number.isFinite(date.getTime())) {
      throw new WagerTransactionError("Transaction processing date is invalid", "INVALID_DATE");
    }
  }

  private static validateIdentity(props: CreateWagerTransactionProps): void {
    const requiredFields = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (requiredFields.some((value) => !value.trim())) {
      throw new WagerTransactionError("Transaction identity fields are required", "INVALID_TRANSACTION");
    }
  }

  private static requiresReferenceKind(kind: WagerTransactionKind): boolean {
    return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  }
}
