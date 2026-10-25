import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DataSource } from "typeorm";
import {
  OutboxPublisher,
  OutboxPublisherLogger,
} from "../../src/application/outbox/outbox-publisher";
import { createDatabaseOptions } from "../../src/database/data-source";
import {
  createSqsPublisherClient,
  readSqsPublisherConfig,
  SqsMessageInput,
  SqsPublisherClient,
} from "../../src/messaging/sqs/sqs-publisher-client";
import {
  parseWagerIntegrationEvent,
} from "../../src/messaging/contracts/integration-event";

const quietLogger: OutboxPublisherLogger = {
  info() {},
  warn() {},
  error() {},
};

let dataSource: DataSource | undefined;
let secondDataSource: DataSource | undefined;
let adminDataSource: DataSource | undefined;
let databaseName: string | undefined;
let testSqsConfig: ReturnType<typeof readSqsPublisherConfig> | undefined;
let testQueueName: string | undefined;
let queueUrl: string;
let rawSqsClient: SQSClient | undefined;
let publisherSqsClient: SqsPublisherClient | undefined;

function getDataSource(): DataSource {
  if (!dataSource) {
    throw new Error("The PostgreSQL integration-test database is not ready");
  }
  return dataSource;
}

function getQueueUrl(): string {
  if (!queueUrl) {
    throw new Error("The LocalStack integration-test queue is not ready");
  }
  return queueUrl;
}

function newEvent() {
  const walletId = randomUUID();
  return {
    eventId: randomUUID(),
    eventType: "WalletBalanceChanged",
    eventVersion: 1,
    aggregateId: walletId,
    occurredAt: new Date(),
    payload: {
      transactionId: randomUUID(),
      walletId,
      playerId: randomUUID(),
      previousBalance: { amount: "10.00", currency: "BRL" },
      balance: { amount: "11.00", currency: "BRL" },
    },
  };
}

async function insertOutboxEvent(
  overrides: {
    event?: ReturnType<typeof newEvent>;
    eventType?: string;
    payload?: Record<string, unknown>;
    attempts?: number;
    claimedBy?: string | null;
    claimExpiresAt?: Date | null;
    failedAt?: Date | null;
    lastError?: string | null;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const event = overrides.event ?? newEvent();
  await getDataSource().query(
    `INSERT INTO outbox_messages (
       event_id, event_type, event_version, aggregate_id, occurred_at, payload,
       attempts, claimed_by, claim_expires_at, failed_at, last_error, created_at
     )
     VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, COALESCE($11, now()))`,
    [
      event.eventId,
      overrides.eventType ?? event.eventType,
      event.aggregateId,
      event.occurredAt,
      JSON.stringify(overrides.payload ?? event.payload),
      overrides.attempts ?? 0,
      overrides.claimedBy ?? null,
      overrides.claimExpiresAt ?? null,
      overrides.failedAt ?? null,
      overrides.lastError ?? null,
      overrides.createdAt ?? null,
    ],
  );
  return event.eventId;
}

interface OutboxRow {
  event_id: string;
  event_type: string;
  event_version: number;
  aggregate_id: string;
  occurred_at: Date;
  causation_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
  published_at: Date | null;
  attempts: number;
  next_attempt_at: Date;
  claimed_by: string | null;
  claim_expires_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
}

async function findOutboxRow(eventId: string): Promise<OutboxRow> {
  const [row] = await getDataSource().query(
    `SELECT event_id, event_type, event_version, aggregate_id, occurred_at,
            causation_id, correlation_id, payload, published_at, attempts,
            next_attempt_at, claimed_by, claim_expires_at, failed_at, last_error
     FROM outbox_messages
     WHERE event_id = $1`,
    [eventId],
  );
  return row as OutboxRow;
}

async function waitForRenewedClaim(eventId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await findOutboxRow(eventId);
    if (
      row.claim_expires_at &&
      row.claim_expires_at.getTime() > Date.now() + 20
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Claim for ${eventId} was not renewed before the deadline`);
}

async function receiveMessage(): Promise<{
  body: string;
  receiptHandle: string;
} | undefined> {
  const response = await rawSqsClient?.send(
    new ReceiveMessageCommand({
      QueueUrl: getQueueUrl(),
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
    }),
  );
  const message = response?.Messages?.[0];
  if (!message?.Body || !message.ReceiptHandle) {
    return undefined;
  }
  return { body: message.Body, receiptHandle: message.ReceiptHandle };
}

async function deleteReceivedMessage(receiptHandle: string): Promise<void> {
  await rawSqsClient?.send(
    new DeleteMessageCommand({
      QueueUrl: getQueueUrl(),
      ReceiptHandle: receiptHandle,
    }),
  );
}

async function receiveAndDelete(): Promise<string> {
  const message = await receiveMessage();
  if (!message) {
    throw new Error("Expected a message in the test-owned SQS queue");
  }
  await deleteReceivedMessage(message.receiptHandle);
  return message.body;
}

class DelegatingSqsClient implements SqsPublisherClient {
  constructor(
    private readonly delegate: SqsPublisherClient,
    private readonly onSend?: (input: SqsMessageInput) => Promise<void>,
  ) {}

  getQueueUrl(queue: string): Promise<string> {
    return this.delegate.getQueueUrl(queue);
  }

  sendMessage(input: SqsMessageInput): Promise<void> {
    return this.onSend
      ? this.onSend(input)
      : this.delegate.sendMessage(input);
  }

  destroy(): void {
    this.delegate.destroy();
  }
}

function createPublisher(
  client: SqsPublisherClient = publisherSqsClient!,
  source: DataSource = getDataSource(),
  options: ConstructorParameters<typeof OutboxPublisher>[4] = {},
): OutboxPublisher {
  return new OutboxPublisher(
    source,
    client,
    getQueueUrl(),
    quietLogger,
    { random: () => 0, ...options },
  );
}

describe("Outbox publisher with temporary PostgreSQL and LocalStack resources", () => {
  beforeAll(async () => {
    const options = createDatabaseOptions();
    if (options.type !== "postgres") {
      throw new Error("Integration tests require PostgreSQL");
    }

    databaseName = `jungle_wagering_test_${randomUUID().replaceAll("-", "")}`;
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

    const config = readSqsPublisherConfig();
    const endpoint = config.endpoint ?? "http://127.0.0.1:14566";
    testSqsConfig = { ...config, endpoint };
    rawSqsClient = new SQSClient({
      region: config.region,
      endpoint,
      credentials: {
        accessKeyId: "localstack",
        secretAccessKey: "localstack",
      },
      maxAttempts: 1,
    });
  });

  beforeEach(async () => {
    if (!rawSqsClient || !testSqsConfig) {
      throw new Error("The LocalStack test client is not ready");
    }
    await getDataSource().query("DELETE FROM outbox_messages");
    testQueueName = `wager-integration-test-${randomUUID().slice(0, 8)}.fifo`;
    const created = await rawSqsClient.send(
      new CreateQueueCommand({
        QueueName: testQueueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
        },
      }),
    );
    if (!created.QueueUrl) {
      throw new Error("LocalStack did not return the temporary queue URL");
    }
    queueUrl = created.QueueUrl;
    publisherSqsClient = createSqsPublisherClient({
      ...testSqsConfig,
      queueName: testQueueName,
    });
  });

  afterEach(async () => {
    publisherSqsClient?.destroy();
    publisherSqsClient = undefined;
    if (rawSqsClient && queueUrl) {
      await rawSqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    queueUrl = "";
    testQueueName = undefined;
  });

  afterAll(async () => {
    if (secondDataSource?.isInitialized) {
      await secondDataSource.destroy();
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (rawSqsClient) {
      rawSqsClient.destroy();
    }
    if (adminDataSource?.isInitialized && databaseName) {
      await adminDataSource.query(`DROP DATABASE "${databaseName}"`);
      await adminDataSource.destroy();
    }
  });

  test("reverts and reapplies the additive Outbox failure-state migration when empty", async () => {
    await getDataSource().undoLastMigration();
    const columnsAfterDown = await getDataSource().query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'outbox_messages'
        AND column_name IN ('failed_at', 'last_error')
    `);
    expect(columnsAfterDown).toHaveLength(0);
    const indexAfterDown = await getDataSource().query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'outbox_messages'
        AND indexname = 'idx_outbox_pending_aggregate_order'
    `);
    expect(indexAfterDown).toHaveLength(0);

    const reapplied = await getDataSource().runMigrations();
    expect(reapplied.map(({ name }) => name)).toEqual([
      "AddOutboxFailureState20261025120000",
    ]);
    const indexAfterUp = await getDataSource().query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'outbox_messages'
        AND indexname = 'idx_outbox_pending_aggregate_order'
    `);
    expect(indexAfterUp).toHaveLength(1);
  });

  test("publishes a validated envelope and confirms only after SQS accepts it", async () => {
    const eventId = await insertOutboxEvent();
    let accepted = false;
    const client = new DelegatingSqsClient(publisherSqsClient!, async (input) => {
      expect((await findOutboxRow(eventId)).published_at).toBeNull();
      expect(input.MessageGroupId).toBe(
        (await findOutboxRow(eventId)).aggregate_id,
      );
      expect(input.MessageDeduplicationId).toBe(eventId);
      await publisherSqsClient!.sendMessage(input);
      accepted = true;
    });

    expect(await createPublisher(client).publishAvailableBatch()).toBe(1);
    expect(accepted).toBe(true);
    const row = await findOutboxRow(eventId);
    expect(row.published_at).toBeInstanceOf(Date);
    expect(row.claimed_by).toBeNull();
    expect(row.claim_expires_at).toBeNull();

    const body = await receiveAndDelete();
    const parsed = parseWagerIntegrationEvent(JSON.parse(body));
    expect(parsed.eventId).toBe(eventId);
    expect(JSON.parse(body)).toEqual(parsed);
  });

  test("reschedules explicit SQS failures without changing event identity", async () => {
    const eventId = await insertOutboxEvent();
    const client = new DelegatingSqsClient(publisherSqsClient!, async () => {
      throw new Error("temporary SQS outage");
    });

    expect(await createPublisher(client).publishAvailableBatch()).toBe(1);
    const row = await findOutboxRow(eventId);
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeInstanceOf(Date);
    expect((row.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());
    expect(row.claimed_by).toBeNull();
    expect(row.last_error).toContain("temporary SQS outage");
    expect(await receiveMessage()).toBeUndefined();
  });

  test("retries ambiguous timeouts with the same event ID and body", async () => {
    const eventId = await insertOutboxEvent();
    const sent: SqsMessageInput[] = [];
    const client = new DelegatingSqsClient(publisherSqsClient!, async (input) => {
      sent.push(input);
      if (sent.length === 1) {
        await publisherSqsClient!.sendMessage(input);
        throw new Error("request timed out after SQS accepted the message");
      }
      await publisherSqsClient!.sendMessage(input);
    });

    await createPublisher(client).publishAvailableBatch();
    await getDataSource().query(
      "UPDATE outbox_messages SET next_attempt_at = now() WHERE event_id = $1",
      [eventId],
    );
    await createPublisher(client).publishAvailableBatch();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0].MessageDeduplicationId).toBe(eventId);
    expect((await findOutboxRow(eventId)).published_at).toBeInstanceOf(Date);
    const delivered = await receiveAndDelete();
    expect(parseWagerIntegrationEvent(JSON.parse(delivered)).eventId).toBe(
      eventId,
    );
  });

  test("recovers an expired claim and publishes its event", async () => {
    const eventId = await insertOutboxEvent({
      claimedBy: "publisher-that-crashed",
      claimExpiresAt: new Date(Date.now() - 1_000),
    });

    await createPublisher().publishAvailableBatch();
    const row = await findOutboxRow(eventId);
    expect(row.published_at).toBeInstanceOf(Date);
    expect(row.attempts).toBe(1);
    expect(row.claimed_by).toBeNull();
    expect(parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId)
      .toBe(eventId);
  });

  test("two publishers with independent pools claim different rows", async () => {
    const firstId = await insertOutboxEvent();
    const secondId = await insertOutboxEvent();
    const firstSent: string[] = [];
    const secondSent: string[] = [];
    const firstClient = new DelegatingSqsClient(
      publisherSqsClient!,
      async (input) => {
        firstSent.push(input.MessageDeduplicationId);
      },
    );
    const secondClient = new DelegatingSqsClient(
      publisherSqsClient!,
      async (input) => {
        secondSent.push(input.MessageDeduplicationId);
      },
    );

    const [firstCount, secondCount] = await Promise.all([
      createPublisher(firstClient, getDataSource(), { batchSize: 1 })
        .publishAvailableBatch(),
      createPublisher(secondClient, secondDataSource!, { batchSize: 1 })
        .publishAvailableBatch(),
    ]);

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
    expect(firstSent).toHaveLength(1);
    expect(secondSent).toHaveLength(1);
    expect(firstSent[0]).not.toBe(secondSent[0]);
    expect(new Set([...firstSent, ...secondSent])).toEqual(
      new Set([firstId, secondId]),
    );
    expect(
      (await getDataSource().query(
        "SELECT count(*)::int AS count FROM outbox_messages WHERE event_id = ANY($1::uuid[]) AND published_at IS NOT NULL",
        [[firstId, secondId]],
      ))[0].count,
    ).toBe(2);
  });

  test("publishes wallet events in creation order and does not claim a later event early", async () => {
    const createdAt = Date.now();
    const firstEvent = newEvent();
    const secondEvent = newEvent();
    secondEvent.aggregateId = firstEvent.aggregateId;
    secondEvent.payload.walletId = firstEvent.aggregateId;
    const firstId = await insertOutboxEvent({
      event: firstEvent,
      createdAt: new Date(createdAt - 2_000),
    });
    const secondId = await insertOutboxEvent({
      event: secondEvent,
      createdAt: new Date(createdAt - 1_000),
    });

    await createPublisher().publishAvailableBatch();
    expect((await findOutboxRow(firstId)).published_at).toBeInstanceOf(Date);
    expect((await findOutboxRow(secondId)).attempts).toBe(0);
    expect(
      parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId,
    ).toBe(firstId);

    await createPublisher().publishAvailableBatch();
    expect((await findOutboxRow(secondId)).published_at).toBeInstanceOf(Date);
    expect(
      parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId,
    ).toBe(secondId);
  });

  test("does not let an old publisher confirm a replaced claim", async () => {
    const eventId = await insertOutboxEvent();
    const client = new DelegatingSqsClient(publisherSqsClient!, async (input) => {
      await publisherSqsClient!.sendMessage(input);
      await getDataSource().query(
        `UPDATE outbox_messages
         SET claimed_by = 'replacement-claim',
             claim_expires_at = now() + interval '60 seconds'
         WHERE event_id = $1`,
        [eventId],
      );
    });

    await createPublisher(client).publishAvailableBatch();
    const row = await findOutboxRow(eventId);
    expect(row.published_at).toBeNull();
    expect(row.claimed_by).toBe("replacement-claim");
    expect(parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId)
      .toBe(eventId);
  });

  test("confirms the current claim even after its lease timestamp expires", async () => {
    const eventId = await insertOutboxEvent();
    const client = new DelegatingSqsClient(publisherSqsClient!, async (input) => {
      await getDataSource().query(
        `UPDATE outbox_messages
         SET claim_expires_at = now() - interval '1 second'
         WHERE event_id = $1`,
        [eventId],
      );
      await publisherSqsClient!.sendMessage(input);
    });

    await createPublisher(client).publishAvailableBatch();

    const row = await findOutboxRow(eventId);
    expect(row.published_at).toBeInstanceOf(Date);
    expect(row.claimed_by).toBeNull();
    expect(row.claim_expires_at).toBeNull();
  });

  test("reschedules an expired lease when its token is still current", async () => {
    const eventId = await insertOutboxEvent();
    const client = new DelegatingSqsClient(publisherSqsClient!, async () => {
      await getDataSource().query(
        `UPDATE outbox_messages
         SET claim_expires_at = now() - interval '1 second'
         WHERE event_id = $1`,
        [eventId],
      );
      throw new Error("temporary network failure");
    });

    await createPublisher(client).publishAvailableBatch();

    const row = await findOutboxRow(eventId);
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.claimed_by).toBeNull();
    expect(row.last_error).toContain("temporary network failure");
  });

  test("does not update an event that became published or terminal during a send", async () => {
    const publishedId = await insertOutboxEvent();
    const terminalId = await insertOutboxEvent();
    const client = new DelegatingSqsClient(
      publisherSqsClient!,
      async (input) => {
        if (input.MessageDeduplicationId === publishedId) {
          await getDataSource().query(
            `UPDATE outbox_messages
             SET published_at = now(),
                 claimed_by = NULL,
                 claim_expires_at = NULL
             WHERE event_id = $1`,
            [publishedId],
          );
          throw new Error("late transport error");
        }
        await getDataSource().query(
          `UPDATE outbox_messages
           SET failed_at = now(),
               last_error = 'existing terminal diagnostic',
               claimed_by = NULL,
               claim_expires_at = NULL
           WHERE event_id = $1`,
          [terminalId],
        );
        throw Object.assign(new Error("invalid message body"), {
          name: "InvalidMessageContents",
        });
      },
    );

    await createPublisher(client).publishAvailableBatch();

    const [published, terminal] = await Promise.all([
      findOutboxRow(publishedId),
      findOutboxRow(terminalId),
    ]);
    expect(published.published_at).toBeInstanceOf(Date);
    expect(published.last_error).toBeNull();
    expect(published.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(terminal.failed_at).toBeInstanceOf(Date);
    expect(terminal.last_error).toBe("existing terminal diagnostic");
    expect(terminal.published_at).toBeNull();
  });

  test("renews a slow send so another publisher cannot claim it or pass its aggregate", async () => {
    const firstEvent = newEvent();
    const secondEvent = newEvent();
    secondEvent.aggregateId = firstEvent.aggregateId;
    secondEvent.payload.walletId = firstEvent.aggregateId;
    const firstId = await insertOutboxEvent({
      event: firstEvent,
      createdAt: new Date(Date.now() - 2_000),
    });
    const secondId = await insertOutboxEvent({
      event: secondEvent,
      createdAt: new Date(Date.now() - 1_000),
    });
    let signalSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const blockedSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const slowClient = new DelegatingSqsClient(
      publisherSqsClient!,
      async (input) => {
        signalSendStarted();
        await blockedSend;
        await publisherSqsClient!.sendMessage(input);
      },
    );

    const firstPublisher = createPublisher(
      slowClient,
      getDataSource(),
      { batchSize: 1, leaseMs: 90 },
    );
    const firstRun = firstPublisher.publishAvailableBatch();
    await sendStarted;
    await getDataSource().query(
      `UPDATE outbox_messages
       SET claim_expires_at = now() - interval '1 second'
       WHERE event_id = $1`,
      [firstId],
    );
    await waitForRenewedClaim(firstId);

    const secondPublisher = createPublisher(
      publisherSqsClient!,
      secondDataSource!,
      { batchSize: 1 },
    );
    expect(await secondPublisher.publishAvailableBatch()).toBe(0);
    expect((await findOutboxRow(firstId)).attempts).toBe(1);
    expect((await findOutboxRow(secondId)).attempts).toBe(0);

    releaseSend();
    await firstRun;
    expect(await secondPublisher.publishAvailableBatch()).toBe(1);
    expect(
      parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId,
    ).toBe(firstId);
    expect(
      parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId,
    ).toBe(secondId);
  });

  test("marks invalid events terminal while continuing with valid events", async () => {
    const invalidId = await insertOutboxEvent({ eventType: "UnsupportedEvent" });
    const validId = await insertOutboxEvent();

    expect(await createPublisher().publishAvailableBatch()).toBe(2);
    const invalid = await findOutboxRow(invalidId);
    expect(invalid.failed_at).toBeInstanceOf(Date);
    expect(invalid.last_error).toContain("eventType is not supported");
    expect(invalid.claimed_by).toBeNull();
    expect((await findOutboxRow(validId)).published_at).toBeInstanceOf(Date);
    expect(
      parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId,
    ).toBe(validId);
  });

  test("marks permanent SQS message errors terminal without retrying", async () => {
    const eventId = await insertOutboxEvent();
    const client = new DelegatingSqsClient(publisherSqsClient!, async () => {
      await getDataSource().query(
        `UPDATE outbox_messages
         SET claim_expires_at = now() - interval '1 second'
         WHERE event_id = $1`,
        [eventId],
      );
      throw Object.assign(new Error("message body is invalid"), {
        Code: "InvalidMessageContents",
      });
    });

    await createPublisher(client).publishAvailableBatch();

    const row = await findOutboxRow(eventId);
    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.last_error).toContain("message body is invalid");
    expect(row.attempts).toBe(1);
    expect(row.claimed_by).toBeNull();
    expect(await createPublisher().publishAvailableBatch()).toBe(0);
  });

  test("global SQS configuration errors release claims without consuming attempts", async () => {
    const eventId = await insertOutboxEvent();
    const secondEventId = await insertOutboxEvent();
    const error = Object.assign(new Error("not authorized"), {
      name: "AccessDeniedException",
    });
    const client = new DelegatingSqsClient(publisherSqsClient!, async () => {
      throw error;
    });

    await expect(
      createPublisher(client, getDataSource(), { batchSize: 1 }).run(
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
    const rows = await Promise.all([
      findOutboxRow(eventId),
      findOutboxRow(secondEventId),
    ]);
    expect(rows.map((row) => row.attempts)).toEqual([0, 0]);
    expect(rows.map((row) => row.failed_at)).toEqual([null, null]);
    expect(rows.map((row) => row.claimed_by)).toEqual([null, null]);
  });

  test("marks the tenth failed attempt terminal and does not claim it again", async () => {
    const eventId = await insertOutboxEvent({ attempts: 9 });
    const client = new DelegatingSqsClient(publisherSqsClient!, async () => {
      throw new Error("permanent publication failure");
    });

    await createPublisher(client).publishAvailableBatch();
    const row = await findOutboxRow(eventId);
    expect(row.attempts).toBe(10);
    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.last_error).toContain("permanent publication failure");
    expect(await createPublisher().publishAvailableBatch()).toBe(0);
  });

  test("marks an exhausted expired claim terminal during recovery", async () => {
    const eventId = await insertOutboxEvent({
      attempts: 10,
      claimedBy: "publisher-that-crashed",
      claimExpiresAt: new Date(Date.now() - 1_000),
    });

    expect(await createPublisher().publishAvailableBatch()).toBe(0);
    const row = await findOutboxRow(eventId);
    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.last_error).toContain("Maximum Outbox publication attempts");
    expect(row.claimed_by).toBeNull();
    expect(await receiveMessage()).toBeUndefined();
  });

  test("leaves an accepted message recoverable when confirmation persistence fails", async () => {
    const eventId = await insertOutboxEvent();
    const sent: SqsMessageInput[] = [];
    await getDataSource().query(`
      CREATE FUNCTION fail_outbox_publish_confirmation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.published_at IS NULL AND NEW.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'forced confirmation write failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await getDataSource().query(`
      CREATE TRIGGER fail_outbox_publish_confirmation
      BEFORE UPDATE ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION fail_outbox_publish_confirmation()
    `);

    try {
      const client = new DelegatingSqsClient(
        publisherSqsClient!,
        async (input) => {
          sent.push(input);
          await publisherSqsClient!.sendMessage(input);
        },
      );
      await expect(
        createPublisher(client).publishAvailableBatch(),
      ).rejects.toThrow(/forced confirmation write failure/);
      const unconfirmed = await findOutboxRow(eventId);
      expect(unconfirmed.published_at).toBeNull();
      expect(unconfirmed.claimed_by).not.toBeNull();

      await getDataSource().query(`
        DROP TRIGGER fail_outbox_publish_confirmation ON outbox_messages
      `);
      await getDataSource().query(
        "DROP FUNCTION fail_outbox_publish_confirmation()",
      );
      await getDataSource().query(
        `UPDATE outbox_messages
         SET claim_expires_at = now() - interval '1 second',
             next_attempt_at = now()
         WHERE event_id = $1`,
        [eventId],
      );
      const retryClient = new DelegatingSqsClient(
        publisherSqsClient!,
        async (input) => {
          sent.push(input);
          await publisherSqsClient!.sendMessage(input);
        },
      );
      await createPublisher(retryClient).publishAvailableBatch();
      const confirmed = await findOutboxRow(eventId);
      expect(confirmed.published_at).toBeInstanceOf(Date);
      expect(confirmed.attempts).toBe(2);
      expect(sent[0]).toEqual(sent[1]);
      expect(parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId)
        .toBe(eventId);
    } finally {
      await getDataSource().query(`
        DROP TRIGGER IF EXISTS fail_outbox_publish_confirmation ON outbox_messages
      `);
      await getDataSource().query(
        "DROP FUNCTION IF EXISTS fail_outbox_publish_confirmation()",
      );
    }
  });

  test("graceful shutdown stops claiming new batches and drains in-flight sends", async () => {
    const firstId = await insertOutboxEvent();
    const secondId = await insertOutboxEvent();
    let signalSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const blockedSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sentIds: string[] = [];
    const client = new DelegatingSqsClient(
      publisherSqsClient!,
      async (input) => {
        sentIds.push(input.MessageDeduplicationId);
        signalSendStarted();
        await blockedSend;
        await publisherSqsClient!.sendMessage(input);
      },
    );
    const abort = new AbortController();
    const run = createPublisher(client, getDataSource(), {
      batchSize: 1,
      pollIntervalMs: 10,
    }).run(abort.signal);

    await sendStarted;
    abort.abort();
    releaseSend();
    await run;

    expect(sentIds).toHaveLength(1);
    expect([firstId, secondId]).toContain(sentIds[0]);
    const rows = (await getDataSource().query(
      "SELECT event_id, claimed_by, published_at FROM outbox_messages WHERE event_id = ANY($1::uuid[])",
      [[firstId, secondId]],
    )) as Array<{
      event_id: string;
      claimed_by: string | null;
      published_at: Date | null;
    }>;
    expect(rows.find((row) => row.event_id === sentIds[0])?.published_at)
      .toBeInstanceOf(Date);
    const notSentId = sentIds[0] === firstId ? secondId : firstId;
    expect(rows.find((row) => row.event_id === notSentId)?.claimed_by).toBeNull();
    expect(
      parseWagerIntegrationEvent(JSON.parse(await receiveAndDelete())).eventId,
    ).toBe(sentIds[0]);
  });

  test("protects migration rollback when terminal failure diagnostics exist", async () => {
    const eventId = await insertOutboxEvent({
      failedAt: new Date(),
      lastError: "preserve this diagnostic",
    });

    await expect(getDataSource().undoLastMigration()).rejects.toThrow(
      /contains failure diagnostics/,
    );
    const row = await findOutboxRow(eventId);
    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.last_error).toBe("preserve this diagnostic");
    expect(row.event_id).toBe(eventId);
  });
});
