export interface MoneyProps {
  amount: string;
  currency: string;
}

const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));
const MAX_MINOR_UNITS = 10n ** 20n - 1n;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.(\d{2})$/;

export class MoneyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyValidationError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(`Cannot combine ${leftCurrency} with ${rightCurrency}`);
    this.name = "CurrencyMismatchError";
  }
}

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const currency = Money.validateCurrency(props.currency);
    const match = AMOUNT_PATTERN.exec(props.amount);

    if (!match) {
      throw new MoneyValidationError(
        "Amount must be a non-negative decimal string with exactly two fractional digits",
      );
    }

    const [, wholeUnits, fractionalUnits] = match;
    const minorUnits = BigInt(wholeUnits) * 100n + BigInt(fractionalUnits);

    return Money.fromMinorUnits(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinorUnits(0n, Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.minorUnits === other.minorUnits
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    const sign = this.minorUnits < 0n ? "-" : "";
    const absoluteUnits = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const wholeUnits = absoluteUnits / 100n;
    const fractionalUnits = (absoluteUnits % 100n).toString().padStart(2, "0");

    return `${sign}${wholeUnits}.${fractionalUnits}`;
  }

  private static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new MoneyValidationError(
        "Amount exceeds the NUMERIC(20,2) database range",
      );
    }

    return new Money(minorUnits, currency);
  }

  private static validateCurrency(currency: string): string {
    if (!CURRENCY_CODES.has(currency)) {
      throw new MoneyValidationError(`Unsupported ISO-4217 currency: ${currency}`);
    }

    return currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
