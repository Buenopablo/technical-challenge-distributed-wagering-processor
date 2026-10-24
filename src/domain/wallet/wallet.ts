import { Money, MoneyProps } from "../money/money";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceChange {
  balanceBefore: Money;
  balanceAfter: Money;
  version: number;
  changed: boolean;
}

export class WalletInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletInvariantError";
  }
}

export class InsufficientWalletBalanceError extends WalletInvariantError {
  constructor() {
    super("Wallet balance is insufficient");
    this.name = "InsufficientWalletBalanceError";
  }
}

export class Wallet {
  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._balance = balance;
    this._version = version;
    this._createdAt = new Date(createdAt);
    this._updatedAt = new Date(updatedAt);
  }

  static open(props: OpenWalletProps): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new WalletInvariantError("Wallet and player IDs are required");
    }

    if (props.initialBalance.isNegative()) {
      throw new WalletInvariantError("Initial wallet balance cannot be negative");
    }

    const at = props.at ?? new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  credit(amount: Money, at = new Date()): BalanceChange {
    if (amount.isNegative()) {
      throw new WalletInvariantError("Credit amount cannot be negative");
    }

    return this.applyChange(amount, at);
  }

  debit(amount: Money, at = new Date()): BalanceChange {
    if (amount.isNegative()) {
      throw new WalletInvariantError("Debit amount cannot be negative");
    }

    return this.applyChange(amount.negate(), at);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: new Date(this.createdAt),
      updatedAt: this.updatedAt,
    };
  }

  private applyChange(delta: Money, at: Date): BalanceChange {
    if (delta.currency !== this.currency) {
      throw new WalletInvariantError(
        `Wallet currency ${this.currency} does not match ${delta.currency}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(delta);

    if (balanceAfter.isNegative()) {
      throw new InsufficientWalletBalanceError();
    }

    const changed = !balanceAfter.equals(balanceBefore);
    if (changed) {
      this._balance = balanceAfter;
      this._version += 1;
      this._updatedAt = new Date(at);
    }

    return {
      balanceBefore,
      balanceAfter,
      version: this._version,
      changed,
    };
  }
}
