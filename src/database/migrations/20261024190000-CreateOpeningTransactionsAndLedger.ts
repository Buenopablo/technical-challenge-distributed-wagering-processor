import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateOpeningTransactionsAndLedger20261024190000
  implements MigrationInterface
{
  name = "CreateOpeningTransactionsAndLedger20261024190000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "wager_transactions",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            default: "gen_random_uuid()",
          },
          {
            name: "provider_id",
            type: "varchar",
            length: "128",
            isNullable: true,
          },
          {
            name: "external_transaction_id",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          { name: "idempotency_key", type: "varchar", length: "255" },
          { name: "payload_hash", type: "char", length: "64" },
          { name: "wallet_id", type: "uuid" },
          { name: "player_id", type: "uuid" },
          {
            name: "round_id",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          {
            name: "game_id",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          { name: "kind", type: "varchar", length: "16" },
          { name: "amount", type: "numeric", precision: 20, scale: 2 },
          { name: "currency", type: "varchar", length: "3" },
          {
            name: "reference_external_transaction_id",
            type: "varchar",
            length: "255",
            isNullable: true,
          },
          {
            name: "reference_transaction_id",
            type: "uuid",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamptz",
            default: "now()",
          },
          {
            name: "status",
            type: "varchar",
            length: "24",
            default: "'PENDING'",
          },
          {
            name: "processed_at",
            type: "timestamptz",
            isNullable: true,
          },
          {
            name: "failure_code",
            type: "varchar",
            length: "64",
            isNullable: true,
          },
        ],
        uniques: [
          {
            name: "uq_wager_transactions_id_wallet",
            columnNames: ["id", "wallet_id"],
          },
        ],
        foreignKeys: [
          {
            name: "fk_wager_transactions_wallet",
            columnNames: ["wallet_id"],
            referencedTableName: "wallets",
            referencedColumnNames: ["id"],
          },
          {
            name: "fk_wager_transactions_reference",
            columnNames: ["reference_transaction_id"],
            referencedTableName: "wager_transactions",
            referencedColumnNames: ["id"],
          },
        ],
        checks: [
          {
            name: "ck_wager_transactions_kind",
            expression:
              `"kind" IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')`,
          },
          {
            name: "ck_wager_transactions_status",
            expression:
              `"status" IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')`,
          },
          {
            name: "ck_wager_transactions_amount_non_negative",
            expression: '"amount" >= 0',
          },
          {
            name: "ck_wager_transactions_currency_format",
            expression: `"currency" ~ '^[A-Z]{3}$'`,
          },
          {
            name: "ck_wager_transactions_payload_hash",
            expression: `"payload_hash" ~ '^[0-9a-f]{64}$'`,
          },
          {
            name: "ck_wager_transactions_origin",
            expression:
              `(("kind" = 'OPENING' AND "provider_id" IS NULL AND "external_transaction_id" IS NULL AND "round_id" IS NULL AND "game_id" IS NULL AND "reference_external_transaction_id" IS NULL AND "reference_transaction_id" IS NULL AND "status" = 'PROCESSED' AND "processed_at" IS NOT NULL AND "amount" > 0 AND "idempotency_key" = 'OPENING:' || "wallet_id"::text) OR ("kind" <> 'OPENING' AND "provider_id" IS NOT NULL AND "external_transaction_id" IS NOT NULL AND "round_id" IS NOT NULL AND "game_id" IS NOT NULL))`,
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      "wager_transactions",
      new TableIndex({
        name: "uq_wager_transactions_opening_wallet",
        columnNames: ["wallet_id"],
        isUnique: true,
        where: `"kind" = 'OPENING'`,
      }),
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

    await queryRunner.createTable(
      new Table({
        name: "wallet_ledger_entries",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            default: "gen_random_uuid()",
          },
          { name: "wallet_id", type: "uuid" },
          { name: "transaction_id", type: "uuid" },
          { name: "direction", type: "varchar", length: "6" },
          { name: "amount", type: "numeric", precision: 20, scale: 2 },
          { name: "currency", type: "varchar", length: "3" },
          {
            name: "balance_before",
            type: "numeric",
            precision: 20,
            scale: 2,
          },
          {
            name: "balance_after",
            type: "numeric",
            precision: 20,
            scale: 2,
          },
          {
            name: "created_at",
            type: "timestamptz",
            default: "now()",
          },
        ],
        uniques: [
          {
            name: "uq_wallet_ledger_transaction_wallet",
            columnNames: ["transaction_id", "wallet_id"],
          },
        ],
        foreignKeys: [
          {
            name: "fk_wallet_ledger_wallet",
            columnNames: ["wallet_id"],
            referencedTableName: "wallets",
            referencedColumnNames: ["id"],
          },
          {
            name: "fk_wallet_ledger_transaction_wallet",
            columnNames: ["transaction_id", "wallet_id"],
            referencedTableName: "wager_transactions",
            referencedColumnNames: ["id", "wallet_id"],
          },
        ],
        checks: [
          {
            name: "ck_wallet_ledger_direction",
            expression: `"direction" IN ('DEBIT', 'CREDIT')`,
          },
          {
            name: "ck_wallet_ledger_positive_amount",
            expression: '"amount" > 0',
          },
          {
            name: "ck_wallet_ledger_non_negative_balances",
            expression: '"balance_before" >= 0 AND "balance_after" >= 0',
          },
          {
            name: "ck_wallet_ledger_currency_format",
            expression: `"currency" ~ '^[A-Z]{3}$'`,
          },
          {
            name: "ck_wallet_ledger_balanced",
            expression:
              `(("direction" = 'CREDIT' AND "balance_after" = "balance_before" + "amount") OR ("direction" = 'DEBIT' AND "balance_after" = "balance_before" - "amount"))`,
          },
        ],
      }),
    );

    await queryRunner.query(`
      CREATE FUNCTION reject_wallet_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only'
          USING ERRCODE = '55000';
      END;
      $$;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_wallet_ledger_append_only
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("wallet_ledger_entries");
    await queryRunner.dropTable("wager_transactions");
    await queryRunner.query("DROP FUNCTION reject_wallet_ledger_mutation()");
  }
}
