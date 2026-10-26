import { MigrationInterface, QueryRunner, TableIndex } from "typeorm";

export class AddWagerReferenceUniqueness20261025140000
  implements MigrationInterface
{
  name = "AddWagerReferenceUniqueness20261025140000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const existingConflicts = (await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM wager_transactions
          WHERE kind <> 'OPENING'
          GROUP BY provider_id, external_transaction_id
          HAVING count(*) > 1
        ) AS "hasDuplicateExternalIdentity",
        EXISTS (
          SELECT 1
          FROM wager_transactions
          WHERE status = 'PROCESSED'
            AND kind IN ('REFUND', 'ROLLBACK')
            AND reference_transaction_id IS NOT NULL
          GROUP BY reference_transaction_id, kind
          HAVING count(*) > 1
        ) AS "hasDuplicateProcessedReversal"
    `)) as Array<{
      hasDuplicateExternalIdentity: boolean;
      hasDuplicateProcessedReversal: boolean;
    }>;
    if (
      existingConflicts[0]?.hasDuplicateExternalIdentity ||
      existingConflicts[0]?.hasDuplicateProcessedReversal
    ) {
      throw new Error(
        "Cannot add wager reference uniqueness: existing transactions contain ambiguous external IDs or duplicate processed reversals",
      );
    }

    await queryRunner.createIndex(
      "wager_transactions",
      new TableIndex({
        name: "uq_wager_transactions_provider_external_transaction",
        columnNames: ["provider_id", "external_transaction_id"],
        isUnique: true,
        where: `"kind" <> 'OPENING'`,
      }),
    );
    await queryRunner.createIndex(
      "wager_transactions",
      new TableIndex({
        name: "uq_wager_transactions_processed_reversal_reference_kind",
        columnNames: ["reference_transaction_id", "kind"],
        isUnique: true,
        where: `"status" = 'PROCESSED' AND "kind" IN ('REFUND', 'ROLLBACK') AND "reference_transaction_id" IS NOT NULL`,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex(
      "wager_transactions",
      "uq_wager_transactions_processed_reversal_reference_kind",
    );
    await queryRunner.dropIndex(
      "wager_transactions",
      "uq_wager_transactions_provider_external_transaction",
    );
  }
}
