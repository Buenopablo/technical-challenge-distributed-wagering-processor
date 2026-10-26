import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";

@Entity({ name: "wager_transactions" })
export class WagerTransactionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "provider_id", type: "varchar", length: 128, nullable: true })
  providerId!: string | null;

  @Column({
    name: "external_transaction_id",
    type: "varchar",
    length: 255,
    nullable: true,
  })
  externalTransactionId!: string | null;

  @Column({ name: "idempotency_key", type: "varchar", length: 255 })
  idempotencyKey!: string;

  @Column({ name: "payload_hash", type: "char", length: 64 })
  payloadHash!: string;

  @Column({ name: "wallet_id", type: "uuid" })
  walletId!: string;

  @Column({ name: "player_id", type: "uuid" })
  playerId!: string;

  @Column({ name: "round_id", type: "varchar", length: 255, nullable: true })
  roundId!: string | null;

  @Column({ name: "game_id", type: "varchar", length: 255, nullable: true })
  gameId!: string | null;

  @Column({ type: "varchar", length: 16 })
  kind!: WagerTransactionKind;

  @Column({ type: "numeric", precision: 20, scale: 2 })
  amount!: string;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @Column({
    name: "reference_external_transaction_id",
    type: "varchar",
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Column({
    name: "reference_transaction_id",
    type: "uuid",
    nullable: true,
  })
  referenceTransactionId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({
    type: "varchar",
    length: 24,
    default: WagerTransactionStatus.Pending,
  })
  status!: WagerTransactionStatus;

  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @Column({ name: "failure_code", type: "varchar", length: 64, nullable: true })
  failureCode!: string | null;

  @Column({ name: "reference_attempts", type: "integer", default: 0 })
  referenceAttempts!: number;

  @Column({
    name: "reference_next_attempt_at",
    type: "timestamptz",
    nullable: true,
  })
  referenceNextAttemptAt!: Date | null;

  @Column({
    name: "result_balance",
    type: "numeric",
    precision: 20,
    scale: 2,
    nullable: true,
  })
  resultBalance!: string | null;

  @Column({ name: "result_currency", type: "varchar", length: 3, nullable: true })
  resultCurrency!: string | null;
}
