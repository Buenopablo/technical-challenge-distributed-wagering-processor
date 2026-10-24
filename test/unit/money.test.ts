import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  Money,
  MoneyValidationError,
} from "../../src/domain/money/money";

describe("Money", () => {
  test("adds decimal values exactly without floating-point conversion", () => {
    const total = Money.from({ amount: "0.10", currency: "BRL" }).add(
      Money.from({ amount: "0.20", currency: "BRL" }),
    );

    expect(total.toJSON()).toEqual({ amount: "0.30", currency: "BRL" });
  });

  test("keeps instances immutable when performing arithmetic", () => {
    const original = Money.from({ amount: "10.25", currency: "BRL" });
    const result = original.subtract(
      Money.from({ amount: "3.10", currency: "BRL" }),
    );

    expect(Object.isFrozen(original)).toBe(true);
    expect(original.toString()).toBe("10.25");
    expect(result.toString()).toBe("7.15");
  });

  test("supports negative intermediate results and serializes them exactly", () => {
    const result = Money.from({ amount: "2.00", currency: "BRL" }).subtract(
      Money.from({ amount: "3.25", currency: "BRL" }),
    );

    expect(result.toString()).toBe("-1.25");
    expect(result.isNegative()).toBe(true);
    expect(result.negate().toString()).toBe("1.25");
  });

  test("rejects malformed or out-of-range amount strings", () => {
    for (const amount of [
      "",
      "1",
      "1.2",
      "1.234",
      "-1.00",
      "1e2",
      "NaN",
      "Infinity",
      "01.00",
      "1000000000000000000.00",
    ]) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(
        MoneyValidationError,
      );
    }
  });

  test("rejects unsupported currency codes", () => {
    expect(() =>
      Money.from({ amount: "1.00", currency: "ZZZ" }),
    ).toThrow(MoneyValidationError);
  });

  test("rejects arithmetic between different currencies", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  test("compares values and creates zero in the requested currency", () => {
    const zero = Money.zero("BRL");
    const positive = Money.from({ amount: "0.01", currency: "BRL" });

    expect(zero.isZero()).toBe(true);
    expect(positive.isPositive()).toBe(true);
    expect(zero.isLessThan(positive)).toBe(true);
  });
});
