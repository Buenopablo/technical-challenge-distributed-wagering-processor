import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from "typeorm";

@Entity({ name: "outbox_messages" })
@Check("ck_outbox_messages_event_type", `length(btrim("event_type")) > 0`)
@Check("ck_outbox_messages_event_version", `"event_version" > 0`)
@Check("ck_outbox_messages_attempts", `"attempts" >= 0`)
@Check(
  "ck_outbox_messages_failure_pair",
  `"failed_at" IS NULL OR "last_error" IS NOT NULL`,
)
@Check(
  "ck_outbox_messages_payload_object",
  `jsonb_typeof("payload") = 'object'`,
)
@Check(
  "ck_outbox_messages_claim_pair",
  `("claimed_by" IS NULL AND "claim_expires_at" IS NULL) OR ("claimed_by" IS NOT NULL AND length(btrim("claimed_by")) > 0 AND "claim_expires_at" IS NOT NULL)`,
)
@Index("idx_outbox_pending_schedule", ["nextAttemptAt", "createdAt"], {
  where: `"published_at" IS NULL`,
})
@Index("idx_outbox_expired_claims", ["claimExpiresAt"], {
  where: `"published_at" IS NULL AND "claim_expires_at" IS NOT NULL`,
})
@Index(
  "idx_outbox_pending_aggregate_order",
  ["aggregateId", "createdAt", "eventId"],
  {
    where: `"published_at" IS NULL AND "failed_at" IS NULL`,
  },
)
export class OutboxMessageEntity {
  @PrimaryColumn({ name: "event_id", type: "uuid" })
  eventId!: string;

  @Column({ name: "event_type", type: "varchar", length: 64 })
  eventType!: string;

  @Column({ name: "event_version", type: "integer" })
  eventVersion!: number;

  @Column({ name: "aggregate_id", type: "uuid" })
  aggregateId!: string;

  @Column({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Column({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Column({ name: "causation_id", type: "varchar", length: 255, nullable: true })
  causationId!: string | null;

  @Column({ name: "correlation_id", type: "varchar", length: 255, nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  @Column({ name: "failed_at", type: "timestamptz", nullable: true })
  failedAt!: Date | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({
    name: "next_attempt_at",
    type: "timestamptz",
    default: () => "now()",
  })
  nextAttemptAt!: Date;

  @Column({ name: "claimed_by", type: "varchar", length: 128, nullable: true })
  claimedBy!: string | null;

  @Column({
    name: "claim_expires_at",
    type: "timestamptz",
    nullable: true,
  })
  claimExpiresAt!: Date | null;
}
