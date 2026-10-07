import { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletLedgerEntryError";
  }
}

export class WalletLedgerEntry {
  private readonly createdAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter, direction } = props;

    if (!Object.values(LedgerDirection).includes(direction)) {
      throw new WalletLedgerEntryError("Ledger direction is invalid");
    }

    if (!money.isPositive()) {
      throw new WalletLedgerEntryError("Ledger amount must be positive");
    }

    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new WalletLedgerEntryError("Ledger balances cannot be negative");
    }

    if (
      money.currency !== balanceBefore.currency ||
      money.currency !== balanceAfter.currency
    ) {
      throw new WalletLedgerEntryError("Ledger amounts and balances must use the same currency");
    }

    const expectedBalance = direction === LedgerDirection.Credit
      ? balanceBefore.add(money)
      : balanceBefore.subtract(money);

    if (!expectedBalance.equals(balanceAfter)) {
      throw new WalletLedgerEntryError("Ledger entry does not balance");
    }

    if (!Number.isFinite(props.createdAt.getTime())) {
      throw new WalletLedgerEntryError("Ledger creation date is invalid");
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  isBalanced(): boolean {
    const expectedBalance = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }
}
