import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";
import { Money } from "./money";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId?: string;
  openingLedgerEntryId?: string;
  createdAt?: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  transactionId: string;
  ledgerEntryId: string;
  money: Money;
  occurredAt?: Date;
}

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export class Wallet {
  private readonly createdAtTimestamp: number;
  private balanceValue: Money;
  private versionValue: number;
  private updatedAtTimestamp: number;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.balanceValue = state.balance;
    this.versionValue = state.version;
    this.createdAtTimestamp = state.createdAt.getTime();
    this.updatedAtTimestamp = state.updatedAt.getTime();
  }

  public readonly id: string;
  public readonly playerId: string;
  public readonly currency: string;

  static open(props: OpenWalletProps): OpenWalletResult {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new WalletError("Wallet id and player id are required", "INVALID_WALLET");
    }

    if (props.initialBalance.isNegative()) {
      throw new WalletError("Initial balance cannot be negative", "NEGATIVE_BALANCE");
    }

    const createdAt = props.createdAt ?? new Date();
    this.assertValidDate(createdAt);

    const wallet = new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });

    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    if (!props.openingTransactionId?.trim() || !props.openingLedgerEntryId?.trim()) {
      throw new WalletError(
        "Opening transaction and ledger entry ids are required for a positive initial balance",
        "OPENING_IDS_REQUIRED",
      );
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingLedgerEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(props.initialBalance.currency),
      balanceAfter: props.initialBalance,
      createdAt,
    });

    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this.balanceValue;
  }

  get version(): number {
    return this.versionValue;
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtTimestamp);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new WalletError("Debit amount must be positive", "INVALID_AMOUNT");
    }

    if (props.money.isLessThan(this.balanceValue) === false &&
      !props.money.equals(this.balanceValue)) {
      throw new WalletError("Wallet balance is insufficient", "INSUFFICIENT_FUNDS");
    }

    return this.applyMovement(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new WalletError("Credit amount must be positive", "INVALID_AMOUNT");
    }

    return this.applyMovement(props, LedgerDirection.Credit);
  }

  private applyMovement(
    props: WalletMovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    if (!props.transactionId.trim() || !props.ledgerEntryId.trim()) {
      throw new WalletError("Transaction and ledger entry ids are required", "INVALID_MOVEMENT");
    }

    const occurredAt = props.occurredAt ?? new Date();
    Wallet.assertValidDate(occurredAt);

    const balanceBefore = this.balanceValue;
    const balanceAfter = direction === LedgerDirection.Credit
      ? balanceBefore.add(props.money)
      : balanceBefore.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: occurredAt,
    });

    this.balanceValue = balanceAfter;
    this.versionValue += 1;
    this.updatedAtTimestamp = occurredAt.getTime();

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new WalletError("Wallet and transaction currencies must match", "CURRENCY_MISMATCH");
    }
  }

  private static assertValidDate(date: Date): void {
    if (!Number.isFinite(date.getTime())) {
      throw new WalletError("Wallet date is invalid", "INVALID_DATE");
    }
  }
}
