import {
  MigrationInterface,
  QueryRunner,
  TableCheck,
  TableColumn,
  TableIndex,
} from "typeorm";

export class AddPendingReferenceRetry20261025150000
  implements MigrationInterface
{
  name = "AddPendingReferenceRetry20261025150000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns("wager_transactions", [
      new TableColumn({
        name: "reference_attempts",
        type: "integer",
        default: "0",
        isNullable: false,
      }),
      new TableColumn({
        name: "reference_next_attempt_at",
        type: "timestamptz",
        isNullable: true,
      }),
    ]);
    await queryRunner.query(`
      UPDATE wager_transactions
      SET reference_next_attempt_at = created_at + INTERVAL '5 seconds'
      WHERE status = 'PENDING_REFERENCE'
    `);
    await queryRunner.createCheckConstraint(
      "wager_transactions",
      new TableCheck({
        name: "ck_wager_transactions_reference_retry",
        expression:
          `("status" <> 'PENDING_REFERENCE' AND "reference_next_attempt_at" IS NULL) OR ("status" = 'PENDING_REFERENCE' AND "reference_next_attempt_at" IS NOT NULL AND "reference_attempts" >= 0)`,
      }),
    );
    await queryRunner.createIndex(
      "wager_transactions",
      new TableIndex({
        name: "idx_wager_transactions_pending_reference_schedule",
        columnNames: ["reference_next_attempt_at", "created_at", "id"],
        where: `"status" = 'PENDING_REFERENCE'`,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
      ) AS "hasPendingReferences"
    `)) as Array<{ hasPendingReferences: boolean }>;
    if (rows[0]?.hasPendingReferences) {
      throw new Error(
        "Cannot revert pending-reference retry state while pending transactions exist",
      );
    }
    await queryRunner.dropIndex(
      "wager_transactions",
      "idx_wager_transactions_pending_reference_schedule",
    );
    await queryRunner.dropCheckConstraint(
      "wager_transactions",
      "ck_wager_transactions_reference_retry",
    );
    await queryRunner.dropColumns("wager_transactions", [
      "reference_next_attempt_at",
      "reference_attempts",
    ]);
  }
}
