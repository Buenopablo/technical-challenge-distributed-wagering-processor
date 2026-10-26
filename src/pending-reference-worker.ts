import "reflect-metadata";
import { DataSource } from "typeorm";
import { ProcessWagerTransactionUseCase } from "./application/wagering/process-wager-transaction.use-case";
import { PendingReferenceWorker } from "./application/wagering/pending-reference-worker";
import { createDatabaseOptions } from "./database/data-source";

async function main(): Promise<void> {
  const dataSource = new DataSource(createDatabaseOptions());
  const abortController = new AbortController();
  const shutdown = (signal: NodeJS.Signals) => {
    console.info("Pending-reference worker received shutdown signal", {
      signal,
    });
    abortController.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await dataSource.initialize();
    console.info("Pending-reference worker started");
    await new PendingReferenceWorker(
      dataSource,
      new ProcessWagerTransactionUseCase(dataSource),
    ).run(abortController.signal);
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
    console.info("Pending-reference worker stopped");
  }
}

main().catch((error: unknown) => {
  console.error("Could not run pending-reference worker.", error);
  process.exitCode = 1;
});
