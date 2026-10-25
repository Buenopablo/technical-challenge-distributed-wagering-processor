import {
  parseWagerIntegrationEvent,
  WagerIntegrationEvent,
} from "../../messaging/contracts/integration-event";

export interface OutboxEventRecord {
  event_id: string;
  event_type: string;
  event_version: number;
  aggregate_id: string;
  occurred_at: Date;
  causation_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

export function reconstructOutboxEvent(
  record: OutboxEventRecord,
): WagerIntegrationEvent {
  return parseWagerIntegrationEvent({
    eventId: record.event_id,
    eventType: record.event_type,
    eventVersion: record.event_version,
    aggregateId: record.aggregate_id,
    occurredAt: record.occurred_at.toISOString(),
    ...(record.causation_id !== null
      ? { causationId: record.causation_id }
      : {}),
    ...(record.correlation_id !== null
      ? { correlationId: record.correlation_id }
      : {}),
    payload: record.payload,
  });
}
