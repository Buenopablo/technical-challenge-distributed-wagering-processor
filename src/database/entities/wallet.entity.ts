import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

@Entity({ name: "wallets" })
@Unique("uq_wallets_player_currency", ["playerId", "currency"])
@Check("ck_wallets_balance_non_negative", `"balance" >= 0`)
@Check("ck_wallets_currency_format", `"currency" ~ '^[A-Z]{3}$'`)
export class WalletEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "player_id", type: "uuid" })
  playerId!: string;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @Column({ type: "numeric", precision: 20, scale: 2, default: "0.00" })
  balance!: string;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
