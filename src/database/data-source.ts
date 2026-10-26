import "reflect-metadata";
import { DataSource, DataSourceOptions } from "typeorm";
import { WalletLedgerEntryEntity } from "./entities/wallet-ledger-entry.entity";
import { WalletEntity } from "./entities/wallet.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { InboxMessageEntity } from "./entities/inbox-message.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";
import { CreateInboxAndOutbox20261024210000 } from "./migrations/20261024210000-CreateInboxAndOutbox";
import { AddOutboxFailureState20261025120000 } from "./migrations/20261025120000-AddOutboxFailureState";
import { AddWagerReferenceUniqueness20261025140000 } from "./migrations/20261025140000-AddWagerReferenceUniqueness";
import { AddPendingReferenceRetry20261025150000 } from "./migrations/20261025150000-AddPendingReferenceRetry";
import { AddWagerIdempotencyResult20261024193000 } from "./migrations/20261024193000-AddWagerIdempotencyResult";
import { CreateOpeningTransactionsAndLedger20261024190000 } from "./migrations/20261024190000-CreateOpeningTransactionsAndLedger";
import { CreateWallets20261024180000 } from "./migrations/20261024180000-CreateWallets";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "55432");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DB_PORT must be an integer between 1 and 65535");
  }

  return port;
}

export function createDatabaseOptions(): DataSourceOptions {
  return {
    type: "postgres",
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: readPort(process.env.DB_PORT),
    username: process.env.DB_USER ?? "jungle_wagering",
    password: process.env.DB_PASSWORD ?? "local-only-password",
    database: process.env.DB_NAME ?? "jungle_wagering",
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ],
    migrations: [
      CreateWallets20261024180000,
      CreateOpeningTransactionsAndLedger20261024190000,
      AddWagerIdempotencyResult20261024193000,
      CreateInboxAndOutbox20261024210000,
      AddOutboxFailureState20261025120000,
      AddWagerReferenceUniqueness20261025140000,
      AddPendingReferenceRetry20261025150000,
    ],
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: "all",
  };
}

export const AppDataSource = new DataSource(createDatabaseOptions());
