export interface MoneyProps {
  amount: string;
  currency: string;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export class Money {
  private static readonly supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));

  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== "string" || !/^\d+\.\d{2}$/.test(props.amount)) {
      throw new MoneyError("Amount must be a non-negative decimal string with exactly two decimal places");
    }

    const currency = this.validateCurrency(props.currency);
    const [whole, fraction] = props.amount.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction);

    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, this.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    const isNegative = this.cents < 0n;
    const absoluteCents = isNegative ? -this.cents : this.cents;
    const whole = absoluteCents / 100n;
    const fraction = (absoluteCents % 100n).toString().padStart(2, "0");
    const sign = isNegative ? "-" : "";

    return `${sign}${whole}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(`Cannot operate on different currencies: ${this.currency} and ${other.currency}`);
    }
  }

  private static validateCurrency(currency: string): string {
    if (!/^[A-Z]{3}$/.test(currency) || !this.supportedCurrencies.has(currency)) {
      throw new MoneyError("Currency must be a supported ISO 4217 code");
    }

    return currency;
  }
}
