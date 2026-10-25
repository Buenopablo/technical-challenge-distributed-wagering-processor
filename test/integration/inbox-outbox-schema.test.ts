import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { createDatabaseOptions } from "../../src/database/data-source";

let testDataSource: DataSource | undefined;
let adminDataSource: DataSource | undefined;
let testDatabaseName: string | undefined;

function getTestDataSource(): DataSource {
  if (!testDataSource) {
    throw new Error("The PostgreSQL integration-test database is not ready");
  }
  return testDataSource;
}

describe("Inbox and Outbox schema in PostgreSQL", () => {
  beforeAll(async () => {
    const options = createDatabaseOptions();
    if (options.type !== "postgres") {
      throw new Error("Integration tests require PostgreSQL");
    }

    testDatabaseName = `jungle_wagering_test_${randomUUID().replaceAll("-", "")}`;
    adminDataSource = new DataSource({
      ...options,
      database: "postgres",
      entities: [],
      migrations: [],
    });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE DATABASE "${testDatabaseName}"`);

    testDataSource = new DataSource({
      ...options,
      database: testDatabaseName,
    });
    await testDataSource.initialize();
    await testDataSource.runMigrations();
  });

  afterAll(async () => {
    if (testDataSource?.isInitialized) {
      await testDataSource.destroy();
    }
    if (adminDataSource?.isInitialized && testDatabaseName) {
      await adminDataSource.query(`DROP DATABASE "${testDatabaseName}"`);
      await adminDataSource.destroy();
    }
  });

  test("reverts and reapplies the empty Inbox and Outbox migration", async () => {
    await getTestDataSource().undoLastMigration();
    await getTestDataSource().undoLastMigration();

    const tablesAfterDown = await getTestDataSource().query(`
      SELECT to_regclass('public.inbox_messages') AS inbox,
             to_regclass('public.outbox_messages') AS outbox
    `);
    expect(tablesAfterDown[0]).toEqual({ inbox: null, outbox: null });

    const reapplied = await getTestDataSource().runMigrations();
    expect(reapplied.map(({ name }) => name)).toEqual([
      "CreateInboxAndOutbox20261024210000",
      "AddOutboxFailureState20261025120000",
    ]);
    const tablesAfterUp = await getTestDataSource().query(`
      SELECT to_regclass('public.inbox_messages') AS inbox,
             to_regclass('public.outbox_messages') AS outbox
    `);
    expect(tablesAfterUp[0]).toEqual({
      inbox: "inbox_messages",
      outbox: "outbox_messages",
    });
  });

  test("enforces Inbox and Outbox uniqueness, fields, checks, and indexes", async () => {
    const dataSource = getTestDataSource();
    const inboxKey = {
      consumer: "wager-consumer-v1",
      messageId: `sqs-${randomUUID()}`,
    };
    const payloadHash = "a".repeat(64);
    await dataSource.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
       VALUES ($1, $2, $3)`,
      [inboxKey.consumer, inboxKey.messageId, payloadHash],
    );
    const [inboxTimestamps] = await dataSource.query(
      `SELECT received_at, processed_at
       FROM inbox_messages
       WHERE consumer_name = $1 AND message_id = $2`,
      [inboxKey.consumer, inboxKey.messageId],
    );
    expect(inboxTimestamps.received_at).toBeInstanceOf(Date);
    expect(inboxTimestamps.processed_at).toBeInstanceOf(Date);
    await expect(
      dataSource.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
         VALUES ($1, $2, $3)`,
        [inboxKey.consumer, inboxKey.messageId, payloadHash],
      ),
    ).rejects.toThrow();
    await expect(
      dataSource.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
         VALUES (' ', 'blank-consumer', $1)`,
        [payloadHash],
      ),
    ).rejects.toThrow();

    await dataSource.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
       VALUES ($1, $2, $3)`,
      ["another-consumer", inboxKey.messageId, payloadHash],
    );
    await expect(
      dataSource.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
         VALUES ($1, $2, $3)`,
        ["invalid-hash", `sqs-${randomUUID()}`, "not-a-sha256"],
      ),
    ).rejects.toThrow();

    const event = {
      eventId: randomUUID(),
      eventType: "WagerTransactionProcessed",
      eventVersion: 1,
      aggregateId: randomUUID(),
      payload: JSON.stringify({
        transactionId: randomUUID(),
        money: { amount: "25.00", currency: "BRL" },
      }),
      occurredAt: new Date(),
    };
    const insertOutbox = (
      overrides: Partial<typeof event> & {
        attempts?: number;
        claimedBy?: string | null;
        claimExpiresAt?: Date | null;
      } = {},
    ) => {
      const row = { ...event, ...overrides };
      return dataSource.query(
        `INSERT INTO outbox_messages (
           event_id, event_type, event_version, aggregate_id, payload,
           occurred_at, attempts, claimed_by, claim_expires_at
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        [
          row.eventId,
          row.eventType,
          row.eventVersion,
          row.aggregateId,
          row.payload,
          row.occurredAt,
          overrides.attempts ?? 0,
          overrides.claimedBy ?? null,
          overrides.claimExpiresAt ?? null,
        ],
      );
    };

    await insertOutbox();
    await expect(insertOutbox()).rejects.toThrow();
    await expect(
      insertOutbox({ eventId: randomUUID(), eventVersion: 0 }),
    ).rejects.toThrow();
    await expect(
      insertOutbox({ eventId: randomUUID(), eventType: " " }),
    ).rejects.toThrow();
    await expect(
      insertOutbox({ eventId: randomUUID(), attempts: -1 }),
    ).rejects.toThrow();
    await expect(
      insertOutbox({ eventId: randomUUID(), payload: JSON.stringify([]) }),
    ).rejects.toThrow();
    await expect(
      insertOutbox({
        eventId: randomUUID(),
        claimedBy: "publisher-1",
        claimExpiresAt: null,
      }),
    ).rejects.toThrow();
    await expect(
      insertOutbox({
        eventId: randomUUID(),
        claimedBy: null,
        claimExpiresAt: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      insertOutbox({
        eventId: randomUUID(),
        claimedBy: " ",
        claimExpiresAt: new Date(),
      }),
    ).rejects.toThrow();
    await insertOutbox({
      eventId: randomUUID(),
      claimedBy: "publisher-1",
      claimExpiresAt: new Date(),
    });

    const [persistedMoney] = await dataSource.query(
      `SELECT payload #>> '{money,amount}' AS amount,
              jsonb_typeof(payload #> '{money,amount}') AS amount_type
       FROM outbox_messages
       WHERE event_id = $1`,
      [event.eventId],
    );
    expect(persistedMoney).toEqual({ amount: "25.00", amount_type: "string" });

    const indexes = (await dataSource.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'outbox_messages'
    `)) as Array<{ indexname: string; indexdef: string }>;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: "idx_outbox_pending_schedule",
          indexdef: expect.stringContaining("WHERE (published_at IS NULL)"),
        }),
        expect.objectContaining({
          indexname: "idx_outbox_expired_claims",
          indexdef: expect.stringContaining("claim_expires_at IS NOT NULL"),
        }),
      ]),
    );

    const inboxColumns = (await dataSource.query(`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'inbox_messages'
    `)) as Array<{
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>;
    expect(inboxColumns).toEqual(
      expect.arrayContaining([
        { column_name: "consumer_name", is_nullable: "NO", data_type: "character varying" },
        { column_name: "message_id", is_nullable: "NO", data_type: "character varying" },
        { column_name: "payload_hash", is_nullable: "NO", data_type: "character" },
        { column_name: "processed_at", is_nullable: "NO", data_type: "timestamp with time zone" },
      ]),
    );
  });

  test("refuses rollback with Inbox or Outbox data without removing rows or tables", async () => {
    const dataSource = getTestDataSource();
    await dataSource.undoLastMigration();
    const [before] = await dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM inbox_messages) AS inbox_count,
        (SELECT count(*)::int FROM outbox_messages) AS outbox_count
    `);
    expect(before.inbox_count).toBeGreaterThan(0);
    expect(before.outbox_count).toBeGreaterThan(0);

    await dataSource.query("DELETE FROM outbox_messages");
    await expect(dataSource.undoLastMigration()).rejects.toThrow(
      /inbox_messages or outbox_messages contains data/,
    );

    const [inboxOnlyAfter] = await dataSource.query(`
      SELECT
        to_regclass('public.inbox_messages') AS inbox_table,
        to_regclass('public.outbox_messages') AS outbox_table,
        (SELECT count(*)::int FROM inbox_messages) AS inbox_count,
        (SELECT count(*)::int FROM outbox_messages) AS outbox_count
    `);
    expect(inboxOnlyAfter).toEqual({
      inbox_table: "inbox_messages",
      outbox_table: "outbox_messages",
      inbox_count: before.inbox_count,
      outbox_count: 0,
    });

    await dataSource.query("DELETE FROM inbox_messages");
    await dataSource.query(
      `INSERT INTO outbox_messages (
         event_id, event_type, event_version, aggregate_id, payload, occurred_at
       )
       VALUES ($1, 'WagerTransactionProcessed', 1, $2, '{}'::jsonb, now())`,
      [randomUUID(), randomUUID()],
    );
    await expect(dataSource.undoLastMigration()).rejects.toThrow(
      /inbox_messages or outbox_messages contains data/,
    );

    const [outboxOnlyAfter] = await dataSource.query(`
      SELECT
        to_regclass('public.inbox_messages') AS inbox_table,
        to_regclass('public.outbox_messages') AS outbox_table,
        (SELECT count(*)::int FROM inbox_messages) AS inbox_count,
        (SELECT count(*)::int FROM outbox_messages) AS outbox_count
    `);
    expect(outboxOnlyAfter).toEqual({
      inbox_table: "inbox_messages",
      outbox_table: "outbox_messages",
      inbox_count: 0,
      outbox_count: 1,
    });
  });
});
