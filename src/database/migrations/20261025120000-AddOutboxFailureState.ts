import {
  MigrationInterface,
  QueryRunner,
  TableCheck,
  TableColumn,
  TableIndex,
} from "typeorm";

export class AddOutboxFailureState20261025120000
  implements MigrationInterface
{
  name = "AddOutboxFailureState20261025120000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "outbox_messages",
      new TableColumn({
        name: "failed_at",
        type: "timestamptz",
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      "outbox_messages",
      new TableColumn({
        name: "last_error",
        type: "text",
        isNullable: true,
      }),
    );
    await queryRunner.createCheckConstraint(
      "outbox_messages",
      new TableCheck({
        name: "ck_outbox_messages_failure_pair",
        expression:
          `"failed_at" IS NULL OR "last_error" IS NOT NULL`,
      }),
    );
    await queryRunner.createIndex(
      "outbox_messages",
      new TableIndex({
        name: "idx_outbox_pending_aggregate_order",
        columnNames: ["aggregate_id", "created_at", "event_id"],
        where: `"published_at" IS NULL AND "failed_at" IS NULL`,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "LOCK TABLE outbox_messages IN ACCESS EXCLUSIVE MODE",
    );
    const rows = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM outbox_messages
        WHERE failed_at IS NOT NULL OR last_error IS NOT NULL
      ) AS "hasFailureData"
    `)) as Array<{ hasFailureData: boolean }>;

    if (rows[0]?.hasFailureData) {
      throw new Error(
        "Cannot revert AddOutboxFailureState: outbox_messages contains failure diagnostics in failed_at or last_error. Archive or otherwise preserve these values before retrying the migration rollback.",
      );
    }

    await queryRunner.dropIndex(
      "outbox_messages",
      "idx_outbox_pending_aggregate_order",
    );
    await queryRunner.dropCheckConstraint(
      "outbox_messages",
      "ck_outbox_messages_failure_pair",
    );
    await queryRunner.dropColumn("outbox_messages", "last_error");
    await queryRunner.dropColumn("outbox_messages", "failed_at");
  }
}
