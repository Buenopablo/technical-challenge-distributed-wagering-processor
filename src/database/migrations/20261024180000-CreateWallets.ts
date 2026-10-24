import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class CreateWallets20261024180000 implements MigrationInterface {
  name = "CreateWallets20261024180000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "wallets",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            default: "gen_random_uuid()",
          },
          { name: "player_id", type: "uuid", isNullable: false },
          { name: "currency", type: "varchar", length: "3", isNullable: false },
          {
            name: "balance",
            type: "numeric",
            precision: 20,
            scale: 2,
            default: "0.00",
            isNullable: false,
          },
          {
            name: "version",
            type: "integer",
            default: "1",
            isNullable: false,
          },
          {
            name: "created_at",
            type: "timestamptz",
            default: "now()",
            isNullable: false,
          },
          {
            name: "updated_at",
            type: "timestamptz",
            default: "now()",
            isNullable: false,
          },
        ],
        uniques: [
          {
            name: "uq_wallets_player_currency",
            columnNames: ["player_id", "currency"],
          },
        ],
        checks: [
          {
            name: "ck_wallets_balance_non_negative",
            expression: '"balance" >= 0',
          },
          {
            name: "ck_wallets_currency_format",
            expression: `"currency" ~ '^[A-Z]{3}$'`,
          },
          {
            name: "ck_wallets_version_positive",
            expression: '"version" > 0',
          },
        ],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("wallets");
  }
}
