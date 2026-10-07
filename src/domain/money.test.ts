import { describe, expect, test } from "bun:test";
import { Money, MoneyError } from "./money";

describe("Money", () => {
  test("parses and serializes decimal strings with two decimal places", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });

    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(money.toString()).toBe("25.00");
  });

  test("preserves exactness for values larger than JavaScript's safe integer range", () => {
    const money = Money.from({ amount: "9007199254740993.01", currency: "BRL" });

    expect(money.add(Money.from({ amount: "0.99", currency: "BRL" })).toString())
      .toBe("9007199254740994.00");
  });

  test("adds, subtracts, and negates without mutating the original values", () => {
    const original = Money.from({ amount: "10.25", currency: "BRL" });
    const other = Money.from({ amount: "3.10", currency: "BRL" });

    expect(original.add(other).toString()).toBe("13.35");
    expect(original.subtract(other).toString()).toBe("7.15");
    expect(original.negate().toString()).toBe("-10.25");
    expect(original.toString()).toBe("10.25");
  });

  test("supports signed results from internal arithmetic", () => {
    const difference = Money.from({ amount: "3.00", currency: "BRL" })
      .subtract(Money.from({ amount: "5.00", currency: "BRL" }));

    expect(difference.isNegative()).toBe(true);
    expect(difference.isPositive()).toBe(false);
    expect(difference.toJSON()).toEqual({ amount: "-2.00", currency: "BRL" });
  });

  test("compares zero, positive, and negative values", () => {
    const zero = Money.zero("BRL");
    const positive = Money.from({ amount: "0.01", currency: "BRL" });
    const negative = positive.negate();

    expect(zero.isZero()).toBe(true);
    expect(positive.isPositive()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isLessThan(zero)).toBe(true);
    expect(zero.equals(Money.from({ amount: "0.00", currency: "BRL" }))).toBe(true);
  });

  test("rejects invalid decimal amounts", () => {
    for (const amount of ["", "NaN", "Infinity", "1e2", "1", "1.2", "1.234", "-1.00"]) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(MoneyError);
    }
  });

  test("rejects invalid currency codes", () => {
    for (const currency of ["", "brl", "BR", "BRLX", "ABC"]) {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(MoneyError);
      expect(() => Money.zero(currency)).toThrow(MoneyError);
    }
  });

  test("rejects operations between different currencies", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(MoneyError);
    expect(() => brl.subtract(usd)).toThrow(MoneyError);
    expect(() => brl.isLessThan(usd)).toThrow(MoneyError);
    expect(() => brl.equals(usd)).toThrow(MoneyError);
  });
});
