import { Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "inbox_messages" })
@Check(
  "ck_inbox_messages_identity",
  `length(btrim("consumer_name")) > 0 AND length(btrim("message_id")) > 0`,
)
@Check(
  "ck_inbox_messages_payload_hash",
  `"payload_hash" ~ '^[0-9a-f]{64}$'`,
)
export class InboxMessageEntity {
  @PrimaryColumn({ name: "consumer_name", type: "varchar", length: 128 })
  consumerName!: string;

  @PrimaryColumn({ name: "message_id", type: "varchar", length: 256 })
  messageId!: string;

  @Column({ name: "payload_hash", type: "char", length: 64 })
  payloadHash!: string;

  @Column({
    name: "received_at",
    type: "timestamptz",
    default: () => "now()",
  })
  receivedAt!: Date;

  @Column({
    name: "processed_at",
    type: "timestamptz",
    default: () => "now()",
  })
  processedAt!: Date;
}
