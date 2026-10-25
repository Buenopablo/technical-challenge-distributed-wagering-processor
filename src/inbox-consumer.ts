import "reflect-metadata";
import { DataSource } from "typeorm";
import {
  createWagerTransactionConsumer,
  readWagerTransactionConsumerConfig,
} from "./application/inbox/wager-transaction-consumer";
import { createDatabaseOptions } from "./database/data-source";
import {
  createSqsConsumerClient,
  readSqsTransactionConsumerConfig,
} from "./messaging/sqs/sqs-publisher-client";

async function main(): Promise<void> {
  const sqsConfig = readSqsTransactionConsumerConfig();
  const consumerConfig = readWagerTransactionConsumerConfig();
  const sqsClient = createSqsConsumerClient(sqsConfig);
  let dataSource: DataSource | undefined;
  const abortController = new AbortController();
  const shutdown = (signal: NodeJS.Signals) => {
    console.info("Wager transaction consumer received shutdown signal", {
      signal,
    });
    abortController.abort();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    const queueUrl = await sqsClient.getQueueUrl(sqsConfig.queueName);
    dataSource = new DataSource(createDatabaseOptions());
    await dataSource.initialize();
    console.info("Wager transaction consumer started", {
      queueName: sqsConfig.queueName,
      region: sqsConfig.region,
      consumerConfig,
    });
    await createWagerTransactionConsumer(
      dataSource,
      sqsClient,
      queueUrl,
      undefined,
      consumerConfig,
    ).run(abortController.signal);
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    try {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    } finally {
      sqsClient.destroy();
      console.info("Wager transaction consumer stopped");
    }
  }
}

main().catch((error: unknown) => {
  console.error("Could not run the wager transaction consumer.", error);
  process.exitCode = 1;
});
