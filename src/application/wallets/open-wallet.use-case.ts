import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { WalletLedgerEntryEntity } from "../../database/entities/wallet-ledger-entry.entity";
import { WalletEntity } from "../../database/entities/wallet.entity";
import { WagerTransactionEntity } from "../../database/entities/wager-transaction.entity";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/ledger/wallet-ledger-entry";
import { Money, MoneyProps } from "../../domain/money/money";
import { Wallet } from "../../domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/wager-transaction/wager-transaction";

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletResult> {
    const initialBalance = Money.from(input.initialBalance);
    const now = new Date();
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
      at: now,
    });

    await this.dataSource.transaction(async (manager) => {
      const walletEntity = manager.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      await manager.save(walletEntity);

      if (!initialBalance.isPositive()) {
        return;
      }

      const transactionId = randomUUID();
      const idempotencyKey = `OPENING:${wallet.id}`;
      const payloadHash = createHash("sha256")
        .update(
          JSON.stringify({
            kind: WagerTransactionKind.Opening,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance.toJSON(),
          }),
        )
        .digest("hex");
      const transaction = WagerTransaction.createOpening({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        idempotencyKey,
        payloadHash,
        createdAt: now,
      });
      transaction.markProcessed(now);

      const transactionState = transaction.toState();
      const transactionEntity = manager.create(WagerTransactionEntity, {
        id: transactionState.id,
        providerId: transactionState.providerId,
        externalTransactionId: transactionState.externalTransactionId,
        idempotencyKey: transactionState.idempotencyKey,
        payloadHash: transactionState.payloadHash,
        walletId: transactionState.walletId,
        playerId: transactionState.playerId,
        roundId: transactionState.roundId,
        gameId: transactionState.gameId,
        kind: transactionState.kind,
        amount: transaction.money.toString(),
        currency: transaction.money.currency,
        referenceExternalTransactionId:
          transactionState.referenceExternalTransactionId,
        referenceTransactionId: transactionState.referenceTransactionId,
        createdAt: transactionState.createdAt,
        status: transactionState.status,
        processedAt: transactionState.processedAt,
        failureCode: null,
      });
      await manager.save(transactionEntity);

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: wallet.balance,
        createdAt: now,
      });
      const ledgerEntity = manager.create(WalletLedgerEntryEntity, {
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
      await manager.save(ledgerEntity);
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
