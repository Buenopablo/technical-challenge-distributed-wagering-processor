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

export type SupportedWagerKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss;

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
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected;
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

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different business payload");
    this.name = "IdempotencyConflictError";
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

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.from(input.money);
    const payloadHash = hashWagerPayload(input);

    return this.dataSource.transaction(async (manager) => {
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
        createdAt: at,
      });

      const insertedRows = (await manager.query(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key,
           payload_hash, wallet_id, player_id, round_id, game_id, kind,
           amount, currency, status, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (idempotency_key) DO NOTHING
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
          WagerTransactionStatus.Pending,
          transaction.createdAt,
        ],
      )) as Array<{ id: string }>;

      if (insertedRows.length === 0) {
        const concurrentExisting = await this.findByIdempotencyKey(
          manager,
          input.idempotencyKey,
        );
        if (!concurrentExisting) {
          throw new Error(
            "Idempotency conflict occurred but the persisted transaction was not found",
          );
        }
        return this.replayOrConflict(concurrentExisting, payloadHash);
      }

      let failureCode: string | undefined;
      let ledgerEntry: WalletLedgerEntry | undefined;
      let balanceChanged = false;

      if (wallet.playerId !== input.playerId) {
        failureCode = "WALLET_PLAYER_MISMATCH";
      } else if (wallet.currency !== money.currency) {
        failureCode = "WALLET_CURRENCY_MISMATCH";
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
      } else if (input.kind === WagerTransactionKind.Win) {
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
      }

      if (failureCode) {
        transaction.reject(failureCode);
      } else {
        transaction.markProcessed(at);
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
          processedAt: transaction.processedAt ?? null,
          failureCode: transaction.failureCode ?? null,
          resultBalance: wallet.balance.toString(),
          resultCurrency: wallet.currency,
        },
      );

      return {
        transactionId: transaction.id,
        status:
          transaction.status === WagerTransactionStatus.Rejected
            ? WagerTransactionStatus.Rejected
            : WagerTransactionStatus.Processed,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        ...(transaction.failureCode
          ? { failureCode: transaction.failureCode }
          : {}),
      };
    });
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
      existing.status !== WagerTransactionStatus.Rejected
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
