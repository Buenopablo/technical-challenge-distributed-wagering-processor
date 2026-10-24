import {
  MigrationInterface,
  QueryRunner,
  TableCheck,
  TableColumn,
  TableIndex,
} from "typeorm";

export class AddWagerIdempotencyResult20261024193000
  implements MigrationInterface
{
  name = "AddWagerIdempotencyResult20261024193000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns("wager_transactions", [
      new TableColumn({
        name: "result_balance",
        type: "numeric",
        precision: 20,
        scale: 2,
        isNullable: true,
      }),
      new TableColumn({
        name: "result_currency",
        type: "varchar",
        length: "3",
        isNullable: true,
      }),
    ]);
    await queryRunner.createCheckConstraint(
      "wager_transactions",
      new TableCheck({
        name: "ck_wager_transactions_terminal_result_snapshot",
        expression: `("kind" = 'OPENING' AND "result_balance" IS NULL AND "result_currency" IS NULL) OR ("kind" <> 'OPENING' AND ("status" NOT IN ('PROCESSED', 'REJECTED', 'FAILED') OR ("result_balance" IS NOT NULL AND "result_currency" IS NOT NULL)))`,
      }),
    );

    await queryRunner.dropIndex(
      "wager_transactions",
      "uq_wager_transactions_opening_key",
    );
    await queryRunner.createIndex(
      "wager_transactions",
      new TableIndex({
        name: "uq_wager_transactions_idempotency_key",
        columnNames: ["idempotency_key"],
        isUnique: true,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const externalTerminalRows = (await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1
         FROM wager_transactions
         WHERE kind <> 'OPENING'
           AND status IN ('PROCESSED', 'REJECTED', 'FAILED')
       ) AS "hasExternalTerminalTransactions"`,
    )) as Array<{ hasExternalTerminalTransactions: boolean }>;

    if (externalTerminalRows[0]?.hasExternalTerminalTransactions) {
      throw new Error(
        "Cannot revert AddWagerIdempotencyResult: external terminal transactions exist and require their result snapshots for idempotent replay. Retain this migration; rollback requires a separately verified snapshot archival strategy.",
      );
    }

    await queryRunner.dropCheckConstraint(
      "wager_transactions",
      "ck_wager_transactions_terminal_result_snapshot",
    );
    await queryRunner.dropIndex(
      "wager_transactions",
      "uq_wager_transactions_idempotency_key",
    );
    await queryRunner.createIndex(
      "wager_transactions",
      new TableIndex({
        name: "uq_wager_transactions_opening_key",
        columnNames: ["idempotency_key"],
        isUnique: true,
        where: `"kind" = 'OPENING'`,
      }),
    );
    await queryRunner.dropColumns("wager_transactions", [
      "result_balance",
      "result_currency",
    ]);
  }
}
