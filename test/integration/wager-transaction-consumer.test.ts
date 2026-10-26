import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DataSource } from "typeorm";
import { WagerTransactionConsumer } from "../../src/application/inbox/wager-transaction-consumer";
import {
  InboxMessageIntegrityConflictError,
  WagerTransactionInboxProcessor,
} from "../../src/application/inbox/wager-transaction-inbox-processor";
import { OpenWalletUseCase } from "../../src/application/wallets/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { createDatabaseOptions } from "../../src/database/data-source";
import { WagerTransactionKind } from "../../src/domain/wager-transaction/wager-transaction";
import {
  createSqsConsumerClient,
  readSqsTransactionConsumerConfig,
  SqsConsumerClient,
  SqsReceivedMessage,
} from "../../src/messaging/sqs/sqs-publisher-client";

const quietLogger = { info() {}, warn() {}, error() {} };

let dataSource: DataSource | undefined;
let secondDataSource: DataSource | undefined;
let adminDataSource: DataSource | undefined;
let databaseName: string | undefined;
let rawSqsClient: SQSClient | undefined;
let consumerClient: SqsConsumerClient | undefined;
let queueName: string | undefined;
let deadLetterQueueName: string | undefined;
let queueUrl: string | undefined;
let deadLetterQueueUrl: string | undefined;

function database(): DataSource {
  if (!dataSource) throw new Error("Temporary PostgreSQL database is not ready");
  return dataSource;
}

function sqs(): SQSClient {
  if (!rawSqsClient) throw new Error("LocalStack client is not ready");
  return rawSqsClient;
}

function queue(): string {
  if (!queueUrl) throw new Error("Temporary SQS queue is not ready");
  return queueUrl;
}

function inputMessage(wallet: { id: string; playerId: string }, overrides: {
  idempotencyKey?: string;
  externalTransactionId?: string;
  amount?: string;
  kind?: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  referenceExternalTransactionId?: string;
} = {}) {
  const data = {
    providerId: "integration-test",
    externalTransactionId: overrides.externalTransactionId ?? randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-test",
    gameId: "game-test",
    kind: overrides.kind ?? "BET",
    money: { amount: overrides.amount ?? "25.00", currency: "BRL" },
    ...(overrides.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            overrides.referenceExternalTransactionId,
        }
      : {}),
  };
  return {
    messageId: `body-${randomUUID()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}

async function createWallet(balance = "100.00"): Promise<{
  id: string;
  playerId: string;
}> {
  const playerId = randomUUID();
  const opened = await new OpenWalletUseCase(database()).execute({
    playerId,
    initialBalance: { amount: balance, currency: "BRL" },
  });
  return { id: opened.id, playerId };
}

async function sendMessage(body: unknown): Promise<void> {
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: queue(),
      MessageBody: JSON.stringify(body),
      MessageGroupId: "integration-test-wallet",
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function receiveMessage(): Promise<SqsReceivedMessage> {
  const result = await sqs().send(
    new ReceiveMessageCommand({
      QueueUrl: queue(),
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 30,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  const message = result.Messages?.[0];
  if (!message?.Body || !message.ReceiptHandle || !message.MessageId) {
    throw new Error("Expected a message in the test-owned SQS queue");
  }
  return {
    body: message.Body,
    receiptHandle: message.ReceiptHandle,
    messageId: message.MessageId,
    approximateReceiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
  };
}

async function setVisible(message: SqsReceivedMessage): Promise<void> {
  await sqs().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queue(),
      ReceiptHandle: message.receiptHandle,
      VisibilityTimeout: 0,
    }),
  );
}

async function receiveWithRetry(): Promise<SqsReceivedMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: queue(),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    const message = response.Messages?.[0];
    if (message?.Body && message.ReceiptHandle && message.MessageId) {
      return {
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        messageId: message.MessageId,
        approximateReceiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      };
    }
  }
  throw new Error("Message did not become visible in the test-owned queue");
}

function createProcessor(source = database()): WagerTransactionInboxProcessor {
  return new WagerTransactionInboxProcessor(
    source,
    new ProcessWagerTransactionUseCase(source),
  );
}

class TrackingConsumerClient implements SqsConsumerClient {
  deleteCount = 0;
  visibilityChanges: number[] = [];
  onDelete?: () => Promise<void>;

  constructor(private readonly delegate: SqsConsumerClient) {}

  getQueueUrl(name: string): Promise<string> {
    return this.delegate.getQueueUrl(name);
  }

  receiveMessages(
    url: string,
    options: Parameters<SqsConsumerClient["receiveMessages"]>[1],
    signal: AbortSignal,
  ): Promise<SqsReceivedMessage[]> {
    return this.delegate.receiveMessages(url, options, signal);
  }

  async deleteMessage(url: string, receipt: string): Promise<void> {
    await this.onDelete?.();
    this.deleteCount += 1;
    await this.delegate.deleteMessage(url, receipt);
  }

  async changeMessageVisibility(
    url: string,
    receipt: string,
    seconds: number,
  ): Promise<void> {
    this.visibilityChanges.push(seconds);
    await this.delegate.changeMessageVisibility(url, receipt, seconds);
  }

  destroy(): void {
    this.delegate.destroy();
  }
}

function createConsumer(client: SqsConsumerClient): WagerTransactionConsumer {
  return new WagerTransactionConsumer(
    client,
    queue(),
    createProcessor(),
    quietLogger,
    {
      batchSize: 1,
      concurrency: 1,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 30,
      pollErrorDelayMs: 10,
      shutdownGraceMs: 100,
    },
  );
}

async function queryCount(sql: string, values: unknown[] = []): Promise<number> {
  const [row] = await database().query(sql, values);
  return Number(row.count);
}

describe("financial SQS consumer with temporary PostgreSQL and LocalStack resources", () => {
  beforeAll(async () => {
    const options = createDatabaseOptions();
    if (options.type !== "postgres") {
      throw new Error("Integration tests require PostgreSQL");
    }
    databaseName = `jungle_wagering_consumer_test_${randomUUID().replaceAll("-", "")}`;
    adminDataSource = new DataSource({
      ...options,
      database: "postgres",
      entities: [],
      migrations: [],
    });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE DATABASE "${databaseName}"`);
    dataSource = new DataSource({ ...options, database: databaseName });
    await dataSource.initialize();
    await dataSource.runMigrations();
    secondDataSource = new DataSource({
      ...options,
      database: databaseName,
      migrationsRun: false,
    });
    await secondDataSource.initialize();

    const config = readSqsTransactionConsumerConfig();
    rawSqsClient = new SQSClient({
      region: config.region,
      endpoint: config.endpoint ?? "http://127.0.0.1:14566",
      credentials: {
        accessKeyId: "localstack",
        secretAccessKey: "localstack",
      },
      maxAttempts: 1,
    });
  });

  beforeEach(async () => {
    if (!rawSqsClient) throw new Error("LocalStack client is not ready");
    queueName = `wager-tx-test-${randomUUID().slice(0, 8)}.fifo`;
    deadLetterQueueName = `wager-tx-dlq-${randomUUID().slice(0, 8)}.fifo`;
    const dlq = await sqs().send(
      new CreateQueueCommand({
        QueueName: deadLetterQueueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
        },
      }),
    );
    deadLetterQueueUrl = dlq.QueueUrl;
    if (!deadLetterQueueUrl) throw new Error("Could not create test DLQ");
    const dlqAttributes = await sqs().send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const arn = dlqAttributes.Attributes?.QueueArn;
    if (!arn) throw new Error("Could not read test DLQ ARN");
    const created = await sqs().send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
        },
      }),
    );
    queueUrl = created.QueueUrl;
    if (!queueUrl) throw new Error("Could not create test input queue");
    await sqs().send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn,
            maxReceiveCount: "2",
          }),
        },
      }),
    );
    const config = readSqsTransactionConsumerConfig();
    consumerClient = createSqsConsumerClient({
      ...config,
      endpoint: config.endpoint ?? "http://127.0.0.1:14566",
      queueName,
    });
  });

  afterEach(async () => {
    consumerClient?.destroy();
    consumerClient = undefined;
    if (queueUrl) await sqs().send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (deadLetterQueueUrl) {
      await sqs().send(new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }));
    }
    queueUrl = undefined;
    deadLetterQueueUrl = undefined;
    queueName = undefined;
    deadLetterQueueName = undefined;
  });

  afterAll(async () => {
    if (secondDataSource?.isInitialized) await secondDataSource.destroy();
    if (dataSource?.isInitialized) await dataSource.destroy();
    rawSqsClient?.destroy();
    if (adminDataSource?.isInitialized && databaseName) {
      await adminDataSource.query(`DROP DATABASE "${databaseName}"`);
      await adminDataSource.destroy();
    }
  });

  test("commits Inbox, wallet, ledger, transaction and Outbox before acknowledging", async () => {
    const wallet = await createWallet();
    const request = inputMessage(wallet);
    await sendMessage(request);
    const received = await receiveMessage();
    const client = new TrackingConsumerClient(consumerClient!);
    client.onDelete = async () => {
      expect(await queryCount(
        "SELECT count(*) FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2",
        ["wager-transaction-consumer", received.messageId],
      )).toBe(1);
      expect(await queryCount(
        "SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1 AND status = 'PROCESSED'",
        [request.data.idempotencyKey],
      )).toBe(1);
      expect(await queryCount(
        "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
        [wallet.id],
      )).toBe(1);
      expect(await queryCount(
        "SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1",
        [wallet.id],
      )).toBe(2);
    };
    await createConsumer(client).processReceivedMessage(received);
    expect(client.deleteCount).toBe(1);
    expect(await queryCount("SELECT count(*) FROM inbox_messages WHERE message_id = $1", [
      received.messageId,
    ])).toBe(1);
    const [balance] = await database().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(balance.balance).toBe("75.00");
  });

  test("processes REFUND from SQS through the shared financial use case", async () => {
    const wallet = await createWallet();
    const referenceExternalTransactionId = `reference-${randomUUID()}`;
    await new ProcessWagerTransactionUseCase(database()).execute({
      idempotencyKey: `seed-bet-${randomUUID()}`,
      providerId: "integration-test",
      externalTransactionId: referenceExternalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-test",
      gameId: "game-test",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    });

    const request = inputMessage(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId,
      amount: "25.00",
    });
    await sendMessage(request);
    const received = await receiveMessage();
    const client = new TrackingConsumerClient(consumerClient!);
    client.onDelete = async () => {
      expect(
        await queryCount(
          `SELECT count(*) FROM inbox_messages
           WHERE consumer_name = $1 AND message_id = $2`,
          ["wager-transaction-consumer", received.messageId],
        ),
      ).toBe(1);
      expect(
        await queryCount(
          `SELECT count(*) FROM wager_transactions
           WHERE external_transaction_id = $1
             AND kind = 'REFUND' AND status = 'PROCESSED'`,
          [request.data.externalTransactionId],
        ),
      ).toBe(1);
      expect(
        await queryCount(
          `SELECT count(*) FROM wallet_ledger_entries
           WHERE wallet_id = $1 AND direction = 'CREDIT'`,
          [wallet.id],
        ),
      ).toBe(2);
    };

    await createConsumer(client).processReceivedMessage(received);
    expect(client.deleteCount).toBe(1);
    const [balance] = await database().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(balance.balance).toBe("100.00");
    expect(
      await queryCount(
        `SELECT count(*) FROM outbox_messages
         WHERE payload ->> 'externalTransactionId' = $1
           AND event_type = 'WagerTransactionProcessed'`,
        [request.data.externalTransactionId],
      ),
    ).toBe(1);
  });

  test("keeps SQS MessageId identity separate from the financial idempotency key", async () => {
    const wallet = await createWallet();
    const key = randomUUID();
    const firstRequest = inputMessage(wallet, { idempotencyKey: key });
    const secondRequest = {
      ...firstRequest,
      messageId: `body-${randomUUID()}`,
    };
    await sendMessage(firstRequest);
    await sendMessage(secondRequest);
    const first = await receiveMessage();
    await createConsumer(new TrackingConsumerClient(consumerClient!))
      .processReceivedMessage(first);
    const second = await receiveWithRetry();
    await createConsumer(new TrackingConsumerClient(consumerClient!))
      .processReceivedMessage(second);

    expect(first.messageId).not.toBe(second.messageId);
    expect(await queryCount(
      "SELECT count(*) FROM inbox_messages WHERE consumer_name = $1 AND message_id IN ($2, $3)",
      ["wager-transaction-consumer", first.messageId, second.messageId],
    )).toBe(2);
    expect(await queryCount(
      "SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1",
      [key],
    )).toBe(1);
    expect(await queryCount(
      "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
  });

  test("serializes concurrent processing of the same SQS MessageId across DataSources", async () => {
    const wallet = await createWallet();
    const request = inputMessage(wallet);
    await sendMessage(request);
    const received = await receiveMessage();
    const [first, second] = await Promise.all([
      createProcessor().process(received.messageId!, received.body!),
      createProcessor(secondDataSource!).process(
        received.messageId!,
        received.body!,
      ),
    ]);

    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(await queryCount(
      "SELECT count(*) FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2",
      ["wager-transaction-consumer", received.messageId],
    )).toBe(1);
    expect(await queryCount("SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1", [
      request.data.idempotencyKey,
    ])).toBe(1);
    expect(await queryCount(
      "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
  });

  test("keeps an Inbox integrity conflict unacknowledged and applies no second effect", async () => {
    const wallet = await createWallet();
    const request = inputMessage(wallet);
    await sendMessage(request);
    const received = await receiveMessage();
    await createProcessor().process(received.messageId!, received.body!);

    const conflictingBody = JSON.stringify({
      ...request,
      data: {
        ...request.data,
        money: { amount: "20.00", currency: "BRL" },
      },
    });
    await expect(
      createProcessor().process(received.messageId!, conflictingBody),
    ).rejects.toBeInstanceOf(InboxMessageIntegrityConflictError);

    expect(await queryCount(
      "SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1",
      [request.data.idempotencyKey],
    )).toBe(1);
    expect(await queryCount(
      "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    const [balance] = await database().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(balance.balance).toBe("75.00");
  });

  test("rolls back Inbox and every financial/outgoing effect on a transaction failure", async () => {
    const wallet = await createWallet();
    const request = inputMessage(wallet);
    await sendMessage(request);
    const received = await receiveMessage();
    await database().query(`
      CREATE FUNCTION reject_consumer_outbox_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected transient failure' USING ERRCODE = '40001';
      END;
      $$ LANGUAGE plpgsql
    `);
    await database().query(`
      CREATE TRIGGER reject_consumer_outbox_insert
      BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION reject_consumer_outbox_insert()
    `);
    const client = new TrackingConsumerClient(consumerClient!);
    await createConsumer(client).processReceivedMessage(received);
    await database().query("DROP TRIGGER reject_consumer_outbox_insert ON outbox_messages");
    await database().query("DROP FUNCTION reject_consumer_outbox_insert()");

    expect(client.deleteCount).toBe(0);
    expect(client.visibilityChanges).toEqual([1]);
    expect(await queryCount("SELECT count(*) FROM inbox_messages WHERE message_id = $1", [
      received.messageId,
    ])).toBe(0);
    expect(await queryCount("SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1", [
      request.data.idempotencyKey,
    ])).toBe(0);
    expect(await queryCount(
      "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(0);
    expect(await queryCount("SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1", [
      wallet.id,
    ])).toBe(0);
    const [balance] = await database().query("SELECT balance FROM wallets WHERE id = $1", [
      wallet.id,
    ]);
    expect(balance.balance).toBe("100.00");

    await setVisible(received);
    const redelivery = await receiveWithRetry();
    expect(redelivery.messageId).toBe(received.messageId);
    const redeliveryClient = new TrackingConsumerClient(consumerClient!);
    const outcome = await createConsumer(redeliveryClient)
      .processReceivedMessage(redelivery);
    expect(outcome).toBe("acknowledged");
    expect(redeliveryClient.deleteCount).toBe(1);
    expect(await queryCount("SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1", [
      request.data.idempotencyKey,
    ])).toBe(1);
    expect(await queryCount(
      "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    const [recoveredBalance] = await database().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(recoveredBalance.balance).toBe("75.00");
  });

  test("keeps a missing-wallet transaction unacknowledged for DLQ review", async () => {
    const wallet = await createWallet();
    const validRequest = inputMessage(wallet);
    const request = {
      ...validRequest,
      data: {
        ...validRequest.data,
        walletId: randomUUID(),
      },
    };
    await sendMessage(request);
    const received = await receiveMessage();
    const client = new TrackingConsumerClient(consumerClient!);
    const outcome = await createConsumer(client).processReceivedMessage(received);

    expect(outcome).toBe("not-acknowledged");
    expect(client.deleteCount).toBe(0);
    expect(client.visibilityChanges).toEqual([]);
    expect(await queryCount("SELECT count(*) FROM inbox_messages WHERE message_id = $1", [
      received.messageId,
    ])).toBe(0);
    expect(await queryCount("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1", [
      request.data.walletId,
    ])).toBe(0);
  });

  test("does not repeat effects when acknowledgement fails and SQS redelivers", async () => {
    const wallet = await createWallet();
    const request = inputMessage(wallet);
    await sendMessage(request);
    const firstDelivery = await receiveMessage();
    const client = new TrackingConsumerClient(consumerClient!);
    client.onDelete = async () => {
      if (client.deleteCount === 0) throw new Error("injected acknowledgement failure");
    };
    const consumer = createConsumer(client);
    await consumer.processReceivedMessage(firstDelivery);
    await setVisible(firstDelivery);
    const redelivery = await receiveWithRetry();
    expect(redelivery.messageId).toBe(firstDelivery.messageId);
    client.onDelete = undefined;
    await consumer.processReceivedMessage(redelivery);

    expect(client.deleteCount).toBe(1);
    expect(await queryCount("SELECT count(*) FROM inbox_messages WHERE message_id = $1", [
      firstDelivery.messageId,
    ])).toBe(1);
    expect(await queryCount("SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1", [
      request.data.idempotencyKey,
    ])).toBe(1);
    expect(await queryCount(
      "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
  });

  test("records terminal insufficient-funds outcome and acknowledges it", async () => {
    const wallet = await createWallet("10.00");
    const request = inputMessage(wallet, { amount: "25.00" });
    await sendMessage(request);
    const received = await receiveMessage();
    const client = new TrackingConsumerClient(consumerClient!);
    await createConsumer(client).processReceivedMessage(received);

    expect(client.deleteCount).toBe(1);
    expect(await queryCount(
      "SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1 AND status = 'REJECTED' AND failure_code = 'INSUFFICIENT_FUNDS'",
      [request.data.idempotencyKey],
    )).toBe(1);
    expect(await queryCount("SELECT count(*) FROM inbox_messages WHERE message_id = $1", [
      received.messageId,
    ])).toBe(1);
    expect(await queryCount("SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1", [
      wallet.id,
    ])).toBe(1);
  });

  test("does not acknowledge malformed messages and lets configured redrive move them to DLQ", async () => {
    await sendMessage({ type: "WagerTransactionRequested", data: {} });
    const client = new TrackingConsumerClient(consumerClient!);
    const consumer = createConsumer(client);
    const first = await receiveMessage();
    await consumer.processReceivedMessage(first);
    await setVisible(first);
    const second = await receiveWithRetry();
    await consumer.processReceivedMessage(second);
    expect(client.deleteCount).toBe(0);
    await setVisible(second);

    let deadLetterMessages = 0;
    for (let attempt = 0; attempt < 6 && deadLetterMessages === 0; attempt += 1) {
      const sourceResponse = await sqs().send(
        new ReceiveMessageCommand({
          QueueUrl: queue(),
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      const sourceMessage = sourceResponse.Messages?.[0];
      if (sourceMessage?.Body && sourceMessage.ReceiptHandle && sourceMessage.MessageId) {
        await consumer.processReceivedMessage({
          body: sourceMessage.Body,
          receiptHandle: sourceMessage.ReceiptHandle,
          messageId: sourceMessage.MessageId,
          approximateReceiveCount: Number(
            sourceMessage.Attributes?.ApproximateReceiveCount ?? 1,
          ),
        });
        await sqs().send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queue(),
            ReceiptHandle: sourceMessage.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      }
      const response = await sqs().send(
        new ReceiveMessageCommand({
          QueueUrl: deadLetterQueueUrl!,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
        }),
      );
      deadLetterMessages = response.Messages?.length ?? 0;
    }
    expect(deadLetterMessages).toBe(1);
  });

  test("drains an in-flight message and exits cleanly after shutdown is requested", async () => {
    const wallet = await createWallet();
    await sendMessage(inputMessage(wallet));
    const controller = new AbortController();
    const client = new TrackingConsumerClient(consumerClient!);
    const consumer = createConsumer(client);
    const abortAfterAck: SqsConsumerClient = {
      getQueueUrl: (name) => client.getQueueUrl(name),
      receiveMessages: (url, options, signal) =>
        client.receiveMessages(url, options, signal),
      deleteMessage: async (url, receipt) => {
        await client.deleteMessage(url, receipt);
        controller.abort();
      },
      changeMessageVisibility: (url, receipt, timeout) =>
        client.changeMessageVisibility(url, receipt, timeout),
      destroy: () => client.destroy(),
    };
    await new WagerTransactionConsumer(
      abortAfterAck,
      queue(),
      createProcessor(),
      quietLogger,
      {
        batchSize: 1,
        concurrency: 1,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 30,
        pollErrorDelayMs: 10,
        shutdownGraceMs: 100,
      },
    ).run(controller.signal);
    expect(client.deleteCount).toBe(1);
    expect(await queryCount("SELECT count(*) FROM wager_transactions")).toBeGreaterThan(0);
  });
});
