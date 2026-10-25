import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableCheck,
  TableIndex,
} from "typeorm";

export class CreateInboxAndOutbox20261024210000
  implements MigrationInterface
{
  name = "CreateInboxAndOutbox20261024210000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "inbox_messages",
        columns: [
          {
            name: "consumer_name",
            type: "varchar",
            length: "128",
            isPrimary: true,
          },
          {
            name: "message_id",
            type: "varchar",
            length: "256",
            isPrimary: true,
          },
          { name: "payload_hash", type: "char", length: "64" },
          { name: "received_at", type: "timestamptz", default: "now()" },
          { name: "processed_at", type: "timestamptz", default: "now()" },
        ],
        checks: [
          new TableCheck({
            name: "ck_inbox_messages_identity",
            expression: `length(btrim("consumer_name")) > 0 AND length(btrim("message_id")) > 0`,
          }),
          new TableCheck({
            name: "ck_inbox_messages_payload_hash",
            expression: `"payload_hash" ~ '^[0-9a-f]{64}$'`,
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "outbox_messages",
        columns: [
          { name: "event_id", type: "uuid", isPrimary: true },
          { name: "event_type", type: "varchar", length: "64" },
          { name: "event_version", type: "integer" },
          { name: "aggregate_id", type: "uuid" },
          { name: "payload", type: "jsonb" },
          { name: "occurred_at", type: "timestamptz" },
          {
            name: "causation_id",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          {
            name: "correlation_id",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "published_at", type: "timestamptz", isNullable: true },
          { name: "attempts", type: "integer", default: "0" },
          { name: "next_attempt_at", type: "timestamptz", default: "now()" },
          {
            name: "claimed_by",
            type: "varchar",
            length: "128",
            isNullable: true,
          },
          {
            name: "claim_expires_at",
            type: "timestamptz",
            isNullable: true,
          },
        ],
        checks: [
          new TableCheck({
            name: "ck_outbox_messages_event_type",
            expression: `length(btrim("event_type")) > 0`,
          }),
          new TableCheck({
            name: "ck_outbox_messages_event_version",
            expression: `"event_version" > 0`,
          }),
          new TableCheck({
            name: "ck_outbox_messages_attempts",
            expression: `"attempts" >= 0`,
          }),
          new TableCheck({
            name: "ck_outbox_messages_payload_object",
            expression: `jsonb_typeof("payload") = 'object'`,
          }),
          new TableCheck({
            name: "ck_outbox_messages_claim_pair",
            expression: `("claimed_by" IS NULL AND "claim_expires_at" IS NULL) OR ("claimed_by" IS NOT NULL AND length(btrim("claimed_by")) > 0 AND "claim_expires_at" IS NOT NULL)`,
          }),
        ],
      }),
    );

    await queryRunner.createIndex(
      "outbox_messages",
      new TableIndex({
        name: "idx_outbox_pending_schedule",
        columnNames: ["next_attempt_at", "created_at"],
        where: `"published_at" IS NULL`,
      }),
    );
    await queryRunner.createIndex(
      "outbox_messages",
      new TableIndex({
        name: "idx_outbox_expired_claims",
        columnNames: ["claim_expires_at"],
        where: `"published_at" IS NULL AND "claim_expires_at" IS NOT NULL`,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "LOCK TABLE inbox_messages, outbox_messages IN ACCESS EXCLUSIVE MODE",
    );
    const rows = (await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM inbox_messages) AS "hasInboxRows",
        EXISTS (SELECT 1 FROM outbox_messages) AS "hasOutboxRows"
    `)) as Array<{ hasInboxRows: boolean; hasOutboxRows: boolean }>;

    if (rows[0]?.hasInboxRows || rows[0]?.hasOutboxRows) {
      throw new Error(
        "Cannot revert CreateInboxAndOutbox: inbox_messages or outbox_messages contains data. Archive or otherwise preserve these records before retrying the migration rollback.",
      );
    }

    await queryRunner.dropTable("outbox_messages");
    await queryRunner.dropTable("inbox_messages");
  }
}
