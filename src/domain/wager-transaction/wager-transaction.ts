import { Money, MoneyProps } from "../money/money";

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

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  createdAt: Date;
  status: WagerTransactionStatus;
  processedAt: Date | null;
}

export class InvalidWagerTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionStateError";
  }
}

export class WagerTransaction {
  private _status: WagerTransactionStatus;
  private _processedAt: Date | undefined;

  private constructor(
    public readonly id: string,
    public readonly providerId: string | null,
    public readonly externalTransactionId: string | null,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | null,
    public readonly gameId: string | null,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | null,
    public readonly referenceTransactionId: string | null,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    processedAt: Date | undefined,
  ) {
    this._status = status;
    this._processedAt = processedAt ? new Date(processedAt) : undefined;
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionStateError(
        "OPENING must have a positive amount",
      );
    }

    return new WagerTransaction(
      props.id,
      null,
      null,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      null,
      null,
      WagerTransactionKind.Opening,
      props.money,
      null,
      null,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
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
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.referenceTransactionId,
      state.createdAt,
      state.status,
      state.processedAt ?? undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  markProcessed(at: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidWagerTransactionStateError(
        `Cannot process a transaction in state ${this._status}`,
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._processedAt = new Date(at);
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      referenceTransactionId: this.referenceTransactionId,
      createdAt: new Date(this.createdAt),
      status: this._status,
      processedAt: this.processedAt ?? null,
    };
  }
}
