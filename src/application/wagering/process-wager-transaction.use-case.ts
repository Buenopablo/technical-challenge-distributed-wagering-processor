import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import {
  InsufficientWalletBalanceError,
  Wallet,
} from "../../domain/wallet/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/ledger/wallet-ledger-entry";
import { Money, MoneyProps } from "../../domain/money/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import { WalletEntity } from "../../database/entities/wallet.entity";
import { WagerTransactionEntity } from "../../database/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../database/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../database/entities/outbox-message.entity";
import { WagerMessageKind } from "../../messaging/contracts/wager-transaction-message";
import { createWagerIntegrationEvents } from "./wager-integration-event.factory";
import { pendingReferenceRetryDelayMs } from "./pending-reference-policy";

export type SupportedWagerKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss
  | WagerTransactionKind.Refund
  | WagerTransactionKind.Rollback;

export interface ProcessWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SupportedWagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status:
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected
    | WagerTransactionStatus.PendingReference;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

interface LockedWalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ExistingTransactionRow {
  id: string;
  payload_hash: string;
  status: WagerTransactionStatus;
  result_balance: string | null;
  result_currency: string | null;
  failure_code: string | null;
}

interface ReferenceTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
}

interface PendingReferenceRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  created_at: Date;
  reference_attempts: number;
  reference_next_attempt_at: Date;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different business payload");
    this.name = "IdempotencyConflictError";
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor() {
    super("Provider external transaction ID was already used");
    this.name = "ExternalTransactionConflictError";
  }
}

export class WagerWalletNotFoundError extends Error {
  constructor() {
    super("Wallet was not found");
    this.name = "WagerWalletNotFoundError";
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortObjectKeys(entry)]),
    );
  }
  return value;
}

export function canonicalizePayload(input: ProcessWagerTransactionInput): string {
  const { idempotencyKey: _excluded, ...businessPayload } = input;
  return JSON.stringify(sortObjectKeys(businessPayload));
}

export function hashWagerPayload(input: ProcessWagerTransactionInput): string {
  return createHash("sha256").update(canonicalizePayload(input)).digest("hex");
}

function toEventKind(kind: WagerTransactionKind): WagerMessageKind {
  switch (kind) {
    case WagerTransactionKind.Bet:
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Loss:
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return kind;
    default:
      throw new Error(`Unsupported external wager kind ${kind}`);
  }
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    return this.dataSource.transaction((manager) =>
      this.executeInTransaction(input, manager),
    );
  }

  async executeInTransaction(
    input: ProcessWagerTransactionInput,
    manager: EntityManager,
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.from(input.money);
    const payloadHash = hashWagerPayload(input);

    const existing = await this.findByIdempotencyKey(
      manager,
      input.idempotencyKey,
    );
    if (existing) {
      return this.replayOrConflict(existing, payloadHash);
    }

    const walletRows = (await manager.query(
      `SELECT id, player_id, currency, balance, version, created_at, updated_at
       FROM wallets
       WHERE id = $1
       FOR UPDATE`,
      [input.walletId],
    )) as LockedWalletRow[];
    const walletRow = walletRows[0];
    if (!walletRow) {
      throw new WagerWalletNotFoundError();
    }

    const wallet = Wallet.rehydrate({
      id: walletRow.id,
      playerId: walletRow.player_id,
      currency: walletRow.currency,
      balance: { amount: walletRow.balance, currency: walletRow.currency },
      version: walletRow.version,
      createdAt: walletRow.created_at,
      updatedAt: walletRow.updated_at,
    });
    const at = new Date();
    const transaction = WagerTransaction.createExternal({
      id: randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId:
        input.referenceExternalTransactionId ?? null,
      createdAt: at,
    });

    if (
      (input.kind === WagerTransactionKind.Refund ||
        input.kind === WagerTransactionKind.Rollback) &&
      !input.referenceExternalTransactionId?.trim()
    ) {
      throw new Error(`${input.kind} requires referenceExternalTransactionId`);
    }
    if (
      input.kind !== WagerTransactionKind.Refund &&
      input.kind !== WagerTransactionKind.Rollback &&
      input.referenceExternalTransactionId !== undefined
    ) {
      throw new Error(
        "referenceExternalTransactionId is only valid for REFUND or ROLLBACK",
      );
    }

    let insertedRows: Array<{ id: string }>;
    try {
      insertedRows = (await manager.query(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key,
           payload_hash, wallet_id, player_id, round_id, game_id, kind,
           amount, currency, reference_external_transaction_id, status, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          transaction.money.toString(),
          transaction.money.currency,
          transaction.referenceExternalTransactionId,
          WagerTransactionStatus.Pending,
          transaction.createdAt,
        ],
      )) as Array<{ id: string }>;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "constraint" in error &&
        error.constraint ===
          "uq_wager_transactions_provider_external_transaction"
      ) {
        throw new ExternalTransactionConflictError();
      }
      throw error;
    }

    if (insertedRows.length === 0) {
      const concurrentExisting = await this.findByIdempotencyKey(
        manager,
        input.idempotencyKey,
      );
      if (concurrentExisting) {
        return this.replayOrConflict(concurrentExisting, payloadHash);
      }
      const externalIdentity = (await manager.query(
        `SELECT id
         FROM wager_transactions
         WHERE provider_id = $1 AND external_transaction_id = $2
         LIMIT 1`,
        [input.providerId, input.externalTransactionId],
      )) as Array<{ id: string }>;
      if (externalIdentity.length > 0) {
        throw new ExternalTransactionConflictError();
      }
      throw new Error(
        "A transaction uniqueness conflict occurred without a matching financial identity",
      );
    }

    let failureCode: string | undefined;
    let ledgerEntry: WalletLedgerEntry | undefined;
    let balanceChanged = false;
    let pendingReference = false;
    let reference: ReferenceTransactionRow | undefined;

    if (wallet.playerId !== input.playerId) {
      failureCode = "WALLET_PLAYER_MISMATCH";
    } else if (wallet.currency !== money.currency) {
      failureCode = "WALLET_CURRENCY_MISMATCH";
    } else if (
      input.kind === WagerTransactionKind.Refund ||
      input.kind === WagerTransactionKind.Rollback
    ) {
      const referenceRows = (await manager.query(
        `SELECT id, provider_id, external_transaction_id, wallet_id,
                player_id, round_id, kind, amount, currency, status
         FROM wager_transactions
         WHERE provider_id = $1 AND external_transaction_id = $2
         FOR UPDATE`,
        [input.providerId, input.referenceExternalTransactionId],
      )) as ReferenceTransactionRow[];
      reference = referenceRows[0];

      if (!reference) {
        pendingReference = true;
      } else {
        transaction.setReferenceTransactionId(reference.id);
        const allowedReference =
          input.kind === WagerTransactionKind.Refund
            ? reference.kind === WagerTransactionKind.Bet
            : reference.kind === WagerTransactionKind.Bet ||
              reference.kind === WagerTransactionKind.Win ||
              reference.kind === WagerTransactionKind.Refund;
        if (!allowedReference) {
          failureCode = "REFERENCE_KIND_NOT_ALLOWED";
        } else if (reference.status !== WagerTransactionStatus.Processed) {
          failureCode = "REFERENCE_NOT_PROCESSED";
        } else if (
          reference.provider_id !== input.providerId ||
          reference.player_id !== input.playerId ||
          reference.wallet_id !== input.walletId ||
          reference.currency !== money.currency ||
          reference.round_id !== input.roundId
        ) {
          failureCode = "REFERENCE_INCOMPATIBLE";
        } else if (reference.amount !== money.toString()) {
          failureCode = "REFERENCE_AMOUNT_MISMATCH";
        } else {
          const priorReversals = (await manager.query(
            `SELECT id
             FROM wager_transactions
             WHERE reference_transaction_id = $1
               AND kind = $2
               AND status = $3
             LIMIT 1`,
            [
              reference.id,
              input.kind,
              WagerTransactionStatus.Processed,
            ],
          )) as Array<{ id: string }>;
          if (priorReversals.length > 0) {
            failureCode = "REFERENCE_ALREADY_REVERSED";
          }
        }
      }
    }

    if (pendingReference) {
      transaction.markPendingReference();
    } else if (failureCode) {
      transaction.reject(failureCode);
    } else if (input.kind === WagerTransactionKind.Bet) {
      try {
        const change = wallet.debit(money, at);
        balanceChanged = change.changed;
        if (change.changed) {
          ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore: change.balanceBefore,
            balanceAfter: change.balanceAfter,
            createdAt: at,
          });
        }
      } catch (error) {
        if (!(error instanceof InsufficientWalletBalanceError)) {
          throw error;
        }
        failureCode = "INSUFFICIENT_FUNDS";
      }
    } else if (
      input.kind === WagerTransactionKind.Win ||
      input.kind === WagerTransactionKind.Refund ||
      (input.kind === WagerTransactionKind.Rollback &&
        reference?.kind === WagerTransactionKind.Bet)
    ) {
      const change = wallet.credit(money, at);
      balanceChanged = change.changed;
      if (change.changed) {
        ledgerEntry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: LedgerDirection.Credit,
          money,
          balanceBefore: change.balanceBefore,
          balanceAfter: change.balanceAfter,
          createdAt: at,
        });
      }
    } else if (
      input.kind === WagerTransactionKind.Rollback &&
      (reference?.kind === WagerTransactionKind.Win ||
        reference?.kind === WagerTransactionKind.Refund)
    ) {
      try {
        const change = wallet.debit(money, at);
        balanceChanged = change.changed;
        if (change.changed) {
          ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore: change.balanceBefore,
            balanceAfter: change.balanceAfter,
            createdAt: at,
          });
        }
      } catch (error) {
        if (!(error instanceof InsufficientWalletBalanceError)) {
          throw error;
        }
        failureCode = "REVERSAL_WOULD_NEGATIVE_BALANCE";
      }
    }

    if (
      failureCode &&
      transaction.status === WagerTransactionStatus.Pending
    ) {
      transaction.reject(failureCode);
    } else if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markProcessed(at, reference?.id);
    }

    if (balanceChanged) {
      await manager.update(
        WalletEntity,
        { id: wallet.id },
        {
          balance: wallet.balance.toString(),
          version: wallet.version,
          updatedAt: wallet.updatedAt,
        },
      );
    }

    if (ledgerEntry) {
      const entity = manager.create(WalletLedgerEntryEntity, {
        id: ledgerEntry.id,
        walletId: ledgerEntry.walletId,
        transactionId: ledgerEntry.transactionId,
        direction: ledgerEntry.direction,
        amount: ledgerEntry.money.toString(),
        currency: ledgerEntry.money.currency,
        balanceBefore: ledgerEntry.balanceBefore.toString(),
        balanceAfter: ledgerEntry.balanceAfter.toString(),
        createdAt: ledgerEntry.createdAt,
      });
      await manager.save(entity);
    }

    await manager.update(
      WagerTransactionEntity,
      { id: transaction.id },
      {
        status: transaction.status,
        referenceTransactionId: transaction.referenceTransactionId,
        referenceNextAttemptAt: pendingReference
          ? new Date(at.getTime() + pendingReferenceRetryDelayMs(1))
          : null,
        processedAt: transaction.processedAt ?? null,
        failureCode: transaction.failureCode ?? null,
        resultBalance: wallet.balance.toString(),
        resultCurrency: wallet.currency,
      },
    );

    const events = createWagerIntegrationEvents({
      transactionId: transaction.id,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      ...(input.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }
        : {}),
      resultBalance: wallet.balance.toJSON(),
      ...(ledgerEntry
        ? { previousBalance: ledgerEntry.balanceBefore.toJSON() }
        : {}),
      occurredAt: at,
      result: pendingReference
        ? { status: "PENDING_REFERENCE" }
        : failureCode
          ? { status: "REJECTED", failureCode }
          : { status: "PROCESSED" },
    });

    for (const event of events) {
      const outboxEntity = manager.create(OutboxMessageEntity, {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        aggregateId: event.aggregateId,
        payload: event.payload,
        occurredAt: new Date(event.occurredAt),
        causationId: event.causationId ?? null,
        correlationId: event.correlationId ?? null,
      });
      await manager.save(OutboxMessageEntity, outboxEntity);
    }

    const resultStatus = transaction.status;
    if (
      resultStatus !== WagerTransactionStatus.Processed &&
      resultStatus !== WagerTransactionStatus.Rejected &&
      resultStatus !== WagerTransactionStatus.PendingReference
    ) {
      throw new Error(
        `Transaction ${transaction.id} did not reach a storable outcome`,
      );
    }

    return {
      transactionId: transaction.id,
      status: resultStatus,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
    };
  }

  async processPendingReferenceInTransaction(
    manager: EntityManager,
    transactionId: string,
    now: Date,
    policy: {
      maxAttempts: number;
      ttlMs: number;
      retryDelayMs: (attempt: number) => number;
    },
  ): Promise<"processed" | "rejected" | "rescheduled" | "skipped"> {
    const candidateRows = (await manager.query(
      `SELECT wallet_id
       FROM wager_transactions
       WHERE id = $1 AND status = $2 AND reference_next_attempt_at <= $3`,
      [transactionId, WagerTransactionStatus.PendingReference, now],
    )) as Array<{ wallet_id: string }>;
    const candidate = candidateRows[0];
    if (!candidate) {
      return "skipped";
    }

    const walletRows = (await manager.query(
      `SELECT id, player_id, currency, balance, version, created_at, updated_at
       FROM wallets
       WHERE id = $1
       FOR UPDATE`,
      [candidate.wallet_id],
    )) as LockedWalletRow[];
    const walletRow = walletRows[0];
    if (!walletRow) {
      throw new WagerWalletNotFoundError();
    }

    const pendingRows = (await manager.query(
      `SELECT id, provider_id, external_transaction_id, idempotency_key,
              payload_hash, wallet_id, player_id, round_id, game_id, kind,
              amount, currency, reference_external_transaction_id,
              reference_transaction_id, status, created_at,
              reference_attempts, reference_next_attempt_at
       FROM wager_transactions
       WHERE id = $1
         AND status = $2
         AND reference_next_attempt_at <= $3
       FOR UPDATE`,
      [transactionId, WagerTransactionStatus.PendingReference, now],
    )) as PendingReferenceRow[];
    const pending = pendingRows[0];
    if (!pending) {
      return "skipped";
    }

    const wallet = Wallet.rehydrate({
      id: walletRow.id,
      playerId: walletRow.player_id,
      currency: walletRow.currency,
      balance: { amount: walletRow.balance, currency: walletRow.currency },
      version: walletRow.version,
      createdAt: walletRow.created_at,
      updatedAt: walletRow.updated_at,
    });
    const money = Money.from({
      amount: pending.amount,
      currency: pending.currency,
    });
    const attempts = pending.reference_attempts + 1;
    const expired =
      now.getTime() - new Date(pending.created_at).getTime() >= policy.ttlMs;
    if (expired) {
      await this.finalizePendingReference(
        manager,
        pending,
        wallet,
        now,
        "REFERENCE_NOT_FOUND",
      );
      return "rejected";
    }

    const referenceRows = (await manager.query(
      `SELECT id, provider_id, external_transaction_id, wallet_id,
              player_id, round_id, kind, amount, currency, status
       FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2
       FOR UPDATE`,
      [pending.provider_id, pending.reference_external_transaction_id],
    )) as ReferenceTransactionRow[];
    const reference = referenceRows[0];

    if (!reference) {
      if (attempts >= policy.maxAttempts) {
        await this.finalizePendingReference(
          manager,
          pending,
          wallet,
          now,
          "REFERENCE_NOT_FOUND",
        );
        return "rejected";
      }
      await manager.update(
        WagerTransactionEntity,
        { id: pending.id },
        {
          referenceAttempts: attempts,
          referenceNextAttemptAt: new Date(
            now.getTime() + policy.retryDelayMs(attempts),
          ),
        },
      );
      return "rescheduled";
    }

    const reversal = WagerTransaction.rehydrate({
      id: pending.id,
      providerId: pending.provider_id,
      externalTransactionId: pending.external_transaction_id,
      idempotencyKey: pending.idempotency_key,
      payloadHash: pending.payload_hash,
      walletId: pending.wallet_id,
      playerId: pending.player_id,
      roundId: pending.round_id,
      gameId: pending.game_id,
      kind: pending.kind,
      money: { amount: pending.amount, currency: pending.currency },
      referenceExternalTransactionId:
        pending.reference_external_transaction_id,
      referenceTransactionId: pending.reference_transaction_id,
      createdAt: pending.created_at,
      status: WagerTransactionStatus.PendingReference,
      processedAt: null,
      failureCode: null,
    });
    reversal.setReferenceTransactionId(reference.id);

    const allowedReference =
      pending.kind === WagerTransactionKind.Refund
        ? reference.kind === WagerTransactionKind.Bet
        : reference.kind === WagerTransactionKind.Bet ||
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund;
    let failureCode: string | undefined;
    if (!allowedReference) {
      failureCode = "REFERENCE_KIND_NOT_ALLOWED";
    } else if (reference.status !== WagerTransactionStatus.Processed) {
      failureCode = "REFERENCE_NOT_PROCESSED";
    } else if (
      reference.provider_id !== pending.provider_id ||
      reference.player_id !== pending.player_id ||
      reference.wallet_id !== pending.wallet_id ||
      reference.currency !== pending.currency ||
      reference.round_id !== pending.round_id
    ) {
      failureCode = "REFERENCE_INCOMPATIBLE";
    } else if (reference.amount !== money.toString()) {
      failureCode = "REFERENCE_AMOUNT_MISMATCH";
    } else {
      const priorReversals = (await manager.query(
        `SELECT id
         FROM wager_transactions
         WHERE reference_transaction_id = $1
           AND kind = $2
           AND status = $3
         LIMIT 1`,
        [reference.id, pending.kind, WagerTransactionStatus.Processed],
      )) as Array<{ id: string }>;
      if (priorReversals.length > 0) {
        failureCode = "REFERENCE_ALREADY_REVERSED";
      }
    }

    let ledgerEntry: WalletLedgerEntry | undefined;
    let balanceChanged = false;
    if (!failureCode) {
      const shouldCredit =
        pending.kind === WagerTransactionKind.Refund ||
        (pending.kind === WagerTransactionKind.Rollback &&
          reference.kind === WagerTransactionKind.Bet);
      try {
        const change = shouldCredit
          ? wallet.credit(money, now)
          : wallet.debit(money, now);
        balanceChanged = change.changed;
        if (change.changed) {
          ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: pending.id,
            direction: shouldCredit
              ? LedgerDirection.Credit
              : LedgerDirection.Debit,
            money,
            balanceBefore: change.balanceBefore,
            balanceAfter: change.balanceAfter,
            createdAt: now,
          });
        }
      } catch (error) {
        if (!(error instanceof InsufficientWalletBalanceError)) {
          throw error;
        }
        failureCode = "REVERSAL_WOULD_NEGATIVE_BALANCE";
      }
    }

    if (failureCode) {
      reversal.reject(failureCode);
    } else {
      reversal.markProcessed(now, reference.id);
    }

    if (balanceChanged) {
      await manager.update(
        WalletEntity,
        { id: wallet.id },
        {
          balance: wallet.balance.toString(),
          version: wallet.version,
          updatedAt: wallet.updatedAt,
        },
      );
    }
    if (ledgerEntry) {
      await manager.save(
        WalletLedgerEntryEntity,
        manager.create(WalletLedgerEntryEntity, {
          id: ledgerEntry.id,
          walletId: ledgerEntry.walletId,
          transactionId: ledgerEntry.transactionId,
          direction: ledgerEntry.direction,
          amount: ledgerEntry.money.toString(),
          currency: ledgerEntry.money.currency,
          balanceBefore: ledgerEntry.balanceBefore.toString(),
          balanceAfter: ledgerEntry.balanceAfter.toString(),
          createdAt: ledgerEntry.createdAt,
        }),
      );
    }
    await manager.update(
      WagerTransactionEntity,
      { id: pending.id },
      {
        status: reversal.status,
        referenceTransactionId: reference.id,
        referenceAttempts: attempts,
        referenceNextAttemptAt: null,
        processedAt: reversal.processedAt ?? now,
        failureCode: reversal.failureCode ?? null,
        resultBalance: wallet.balance.toString(),
        resultCurrency: wallet.currency,
      },
    );

    await this.persistIntegrationEvents(manager, {
      transactionId: pending.id,
      providerId: pending.provider_id,
      externalTransactionId: pending.external_transaction_id,
      playerId: pending.player_id,
      walletId: pending.wallet_id,
      roundId: pending.round_id,
      gameId: pending.game_id,
      kind: toEventKind(pending.kind),
      referenceExternalTransactionId:
        pending.reference_external_transaction_id,
      money: money.toJSON(),
      resultBalance: wallet.balance.toJSON(),
      ...(ledgerEntry
        ? { previousBalance: ledgerEntry.balanceBefore.toJSON() }
        : {}),
      occurredAt: now,
      result: failureCode
        ? { status: "REJECTED", failureCode }
        : { status: "PROCESSED" },
    });
    return failureCode ? "rejected" : "processed";
  }

  private async finalizePendingReference(
    manager: EntityManager,
    pending: PendingReferenceRow,
    wallet: Wallet,
    now: Date,
    failureCode: string,
  ): Promise<void> {
    const reversal = WagerTransaction.rehydrate({
      id: pending.id,
      providerId: pending.provider_id,
      externalTransactionId: pending.external_transaction_id,
      idempotencyKey: pending.idempotency_key,
      payloadHash: pending.payload_hash,
      walletId: pending.wallet_id,
      playerId: pending.player_id,
      roundId: pending.round_id,
      gameId: pending.game_id,
      kind: pending.kind,
      money: { amount: pending.amount, currency: pending.currency },
      referenceExternalTransactionId:
        pending.reference_external_transaction_id,
      referenceTransactionId: pending.reference_transaction_id,
      createdAt: pending.created_at,
      status: WagerTransactionStatus.PendingReference,
      processedAt: null,
      failureCode: null,
    });
    reversal.reject(failureCode);
    await manager.update(
      WagerTransactionEntity,
      { id: pending.id },
      {
        status: reversal.status,
        referenceAttempts: pending.reference_attempts + 1,
        referenceNextAttemptAt: null,
        processedAt: now,
        failureCode,
        resultBalance: wallet.balance.toString(),
        resultCurrency: wallet.currency,
      },
    );
    await this.persistIntegrationEvents(manager, {
      transactionId: pending.id,
      providerId: pending.provider_id,
      externalTransactionId: pending.external_transaction_id,
      playerId: pending.player_id,
      walletId: pending.wallet_id,
      roundId: pending.round_id,
      gameId: pending.game_id,
      kind: toEventKind(pending.kind),
      referenceExternalTransactionId:
        pending.reference_external_transaction_id,
      money: Money.from({
        amount: pending.amount,
        currency: pending.currency,
      }).toJSON(),
      resultBalance: wallet.balance.toJSON(),
      occurredAt: now,
      result: { status: "REJECTED", failureCode },
    });
  }

  private async persistIntegrationEvents(
    manager: EntityManager,
    input: Parameters<typeof createWagerIntegrationEvents>[0],
  ): Promise<void> {
    const events = createWagerIntegrationEvents(input);
    for (const event of events) {
      await manager.save(
        OutboxMessageEntity,
        manager.create(OutboxMessageEntity, {
          eventId: event.eventId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          aggregateId: event.aggregateId,
          payload: event.payload,
          occurredAt: new Date(event.occurredAt),
          causationId: event.causationId ?? null,
          correlationId: event.correlationId ?? null,
        }),
      );
    }
  }

  private async findByIdempotencyKey(
    manager: EntityManager,
    key: string,
  ): Promise<ExistingTransactionRow | undefined> {
    const rows = (await manager.query(
      `SELECT id, payload_hash, status, result_balance, result_currency, failure_code
       FROM wager_transactions
       WHERE idempotency_key = $1`,
      [key],
    )) as ExistingTransactionRow[];
    return rows[0];
  }

  private replayOrConflict(
    existing: ExistingTransactionRow,
    payloadHash: string,
  ): ProcessWagerTransactionResult {
    if (existing.payload_hash !== payloadHash) {
      throw new IdempotencyConflictError();
    }
    if (
      existing.status !== WagerTransactionStatus.Processed &&
      existing.status !== WagerTransactionStatus.Rejected &&
      existing.status !== WagerTransactionStatus.PendingReference
    ) {
      throw new Error(
        `Idempotency key points to a non-terminal transaction (${existing.status})`,
      );
    }
    if (existing.result_balance === null || existing.result_currency === null) {
      throw new Error("Persisted transaction is missing its original result snapshot");
    }

    return {
      transactionId: existing.id,
      status: existing.status,
      balance: {
        amount: existing.result_balance,
        currency: existing.result_currency,
      },
      idempotentReplay: true,
      ...(existing.failure_code ? { failureCode: existing.failure_code } : {}),
    };
  }
}
