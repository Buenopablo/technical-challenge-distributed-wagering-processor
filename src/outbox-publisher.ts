import "reflect-metadata";
import { DataSource } from "typeorm";
import { OutboxPublisher } from "./application/outbox/outbox-publisher";
import { createDatabaseOptions } from "./database/data-source";
import {
  createSqsPublisherClient,
  readSqsPublisherConfig,
} from "./messaging/sqs/sqs-publisher-client";

async function main(): Promise<void> {
  const config = readSqsPublisherConfig();
  const sqsClient = createSqsPublisherClient(config);
  let dataSource: DataSource | undefined;
  const abortController = new AbortController();
  const shutdown = (signal: NodeJS.Signals) => {
    console.info("Outbox publisher received shutdown signal", { signal });
    abortController.abort();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    const queueUrl = await sqsClient.getQueueUrl(config.queueName);
    dataSource = new DataSource(createDatabaseOptions());
    await dataSource.initialize();
    console.info("Outbox publisher started", {
      queueName: config.queueName,
      region: config.region,
    });
    await new OutboxPublisher(dataSource, sqsClient, queueUrl).run(
      abortController.signal,
    );
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    sqsClient.destroy();
    console.info("Outbox publisher stopped");
  }
}

main().catch((error: unknown) => {
  console.error("Could not run Outbox publisher.", error);
  process.exitCode = 1;
});
