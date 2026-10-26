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

export interface CreateExternalWagerTransactionProps {
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
  referenceExternalTransactionId?: string | null;
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
  failureCode: string | null;
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
  private _failureCode: string | undefined;
  private _referenceTransactionId: string | null;

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
    referenceTransactionId: string | null,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    processedAt: Date | undefined,
    failureCode: string | undefined,
  ) {
    this._status = status;
    this._processedAt = processedAt ? new Date(processedAt) : undefined;
    this._failureCode = failureCode;
    this._referenceTransactionId = referenceTransactionId;
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
      undefined,
    );
  }

  static createExternal(
    props: CreateExternalWagerTransactionProps,
  ): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionStateError(
        "OPENING transactions can only be created internally",
      );
    }
    const reversal =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (reversal && !props.referenceExternalTransactionId?.trim()) {
      throw new InvalidWagerTransactionStateError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (
      !reversal &&
      props.referenceExternalTransactionId !== undefined &&
      props.referenceExternalTransactionId !== null
    ) {
      throw new InvalidWagerTransactionStateError(
        "Only REFUND and ROLLBACK can reference another transaction",
      );
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
      props.referenceExternalTransactionId ?? null,
      null,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
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
      state.failureCode ?? undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  markProcessed(at: Date, referenceTransactionId?: string): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidWagerTransactionStateError(
        `Cannot process a transaction in state ${this._status}`,
      );
    }

    if (
      (this.kind === WagerTransactionKind.Refund ||
        this.kind === WagerTransactionKind.Rollback) &&
      !referenceTransactionId &&
      !this._referenceTransactionId
    ) {
      throw new InvalidWagerTransactionStateError(
        `${this.kind} cannot be processed without a resolved reference`,
      );
    }
    if (referenceTransactionId) {
      this.setReferenceTransactionId(referenceTransactionId);
    }
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = new Date(at);
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidWagerTransactionStateError(
        `Cannot defer a transaction in state ${this._status}`,
      );
    }
    if (
      this.kind !== WagerTransactionKind.Refund &&
      this.kind !== WagerTransactionKind.Rollback
    ) {
      throw new InvalidWagerTransactionStateError(
        "Only REFUND and ROLLBACK can have a pending reference",
      );
    }
    if (!this.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionStateError(
        "A pending reference transaction must identify its external reference",
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  setReferenceTransactionId(referenceTransactionId: string): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidWagerTransactionStateError(
        `Cannot change a reference in state ${this._status}`,
      );
    }
    if (
      this.kind !== WagerTransactionKind.Refund &&
      this.kind !== WagerTransactionKind.Rollback
    ) {
      throw new InvalidWagerTransactionStateError(
        "Only REFUND and ROLLBACK can reference another transaction",
      );
    }
    if (!referenceTransactionId.trim()) {
      throw new InvalidWagerTransactionStateError(
        "A reference transaction ID is required",
      );
    }
    if (
      this._referenceTransactionId &&
      this._referenceTransactionId !== referenceTransactionId
    ) {
      throw new InvalidWagerTransactionStateError(
        "The reference transaction cannot be changed",
      );
    }
    this._referenceTransactionId = referenceTransactionId;
  }

  reject(failureCode: string): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidWagerTransactionStateError(
        `Cannot reject a transaction in state ${this._status}`,
      );
    }
    if (!failureCode.trim()) {
      throw new InvalidWagerTransactionStateError(
        "A rejection failure code is required",
      );
    }

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = failureCode;
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
      referenceTransactionId: this._referenceTransactionId,
      createdAt: new Date(this.createdAt),
      status: this._status,
      processedAt: this.processedAt ?? null,
      failureCode: this._failureCode ?? null,
    };
  }
}
