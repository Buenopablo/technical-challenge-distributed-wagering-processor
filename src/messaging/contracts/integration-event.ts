import {
  Money,
  MoneyProps,
  MoneyValidationError,
} from "../../domain/money/money";
import { WagerMessageKind } from "./wager-transaction-message";

export const INTEGRATION_EVENT_VERSION = 1 as const;

export interface IntegrationEventEnvelope<
  EventType extends string,
  Payload,
> {
  eventId: string;
  eventType: EventType;
  eventVersion: typeof INTEGRATION_EVENT_VERSION;
  occurredAt: string;
  aggregateId: string;
  causationId?: string;
  correlationId?: string;
  payload: Payload;
}

export type WagerTransactionProcessedEvent = IntegrationEventEnvelope<
  "WagerTransactionProcessed",
  {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerMessageKind;
    money: MoneyProps;
    resultBalance: MoneyProps;
  }
>;

export type WagerTransactionRejectedEvent = IntegrationEventEnvelope<
  "WagerTransactionRejected",
  {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerMessageKind;
    money: MoneyProps;
    resultBalance: MoneyProps;
    failureCode: string;
  }
>;

export type WalletBalanceChangedEvent = IntegrationEventEnvelope<
  "WalletBalanceChanged",
  {
    transactionId: string;
    walletId: string;
    playerId: string;
    previousBalance: MoneyProps;
    balance: MoneyProps;
  }
>;

export type WagerIntegrationEvent =
  | WagerTransactionProcessedEvent
  | WagerTransactionRejectedEvent
  | WalletBalanceChangedEvent;

export class InvalidIntegrationEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIntegrationEventError";
  }
}

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function invalid(message: string): never {
  throw new InvalidIntegrationEventError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: JsonRecord,
  field: string,
  maxLength: number,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    candidate.length > maxLength
  ) {
    return invalid(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return candidate;
}

function requiredUuid(value: JsonRecord, field: string): string {
  const candidate = requiredString(value, field, 36);
  if (!UUID_PATTERN.test(candidate)) {
    return invalid(`${field} must be a UUID`);
  }
  return candidate;
}

function optionalString(value: JsonRecord, field: string): string | undefined {
  return value[field] === undefined
    ? undefined
    : requiredString(value, field, 255);
}

function requiredMoney(value: JsonRecord, field: string): MoneyProps {
  const candidate = value[field];
  if (!isRecord(candidate)) {
    return invalid(`${field} must contain amount and currency`);
  }
  if (
    typeof candidate.amount !== "string" ||
    typeof candidate.currency !== "string"
  ) {
    return invalid(`${field}.amount and ${field}.currency must be strings`);
  }

  try {
    return Money.from({
      amount: candidate.amount,
      currency: candidate.currency,
    }).toJSON();
  } catch (error) {
    if (error instanceof MoneyValidationError) {
      return invalid(`${field}: ${error.message}`);
    }
    throw error;
  }
}

function requiredKind(value: JsonRecord): WagerMessageKind {
  if (value.kind === "BET" || value.kind === "WIN" || value.kind === "LOSS") {
    return value.kind;
  }
  return invalid("payload.kind must be BET, WIN, or LOSS");
}

function requiredUtcTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    return invalid("occurredAt must be an ISO-8601 UTC timestamp");
  }
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return invalid(
      "occurredAt must be an ISO-8601 UTC timestamp with at most millisecond precision",
    );
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((fraction ?? "").padEnd(3, "0"));

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    date.toISOString() !==
      `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${String(milliseconds).padStart(3, "0")}Z`
  ) {
    return invalid("occurredAt must be a valid ISO-8601 UTC timestamp");
  }
  return value;
}

function requiredEnvelope(
  input: JsonRecord,
  expectedType: WagerIntegrationEvent["eventType"],
): {
  eventId: string;
  occurredAt: string;
  aggregateId: string;
  causationId: string | undefined;
  correlationId: string | undefined;
} {
  if (input.eventType !== expectedType) {
    return invalid(`eventType must be ${expectedType}`);
  }
  if (input.eventVersion !== INTEGRATION_EVENT_VERSION) {
    return invalid(`eventVersion must be ${INTEGRATION_EVENT_VERSION}`);
  }
  return {
    eventId: requiredUuid(input, "eventId"),
    occurredAt: requiredUtcTimestamp(input.occurredAt),
    aggregateId: requiredUuid(input, "aggregateId"),
    causationId: optionalString(input, "causationId"),
    correlationId: optionalString(input, "correlationId"),
  };
}

function requiredPayload(input: JsonRecord): JsonRecord {
  if (!isRecord(input.payload)) {
    return invalid("payload must be a JSON object");
  }
  return input.payload;
}

function validateWagerAggregate(
  aggregateId: string,
  walletId: string,
): void {
  if (aggregateId.toLowerCase() !== walletId.toLowerCase()) {
    invalid("aggregateId must match payload.walletId");
  }
}

export function parseWagerIntegrationEvent(
  input: unknown,
): WagerIntegrationEvent {
  if (!isRecord(input)) {
    return invalid("Integration event must be a JSON object");
  }

  if (input.eventType === "WagerTransactionProcessed") {
    const envelope = requiredEnvelope(input, "WagerTransactionProcessed");
    const payload = requiredPayload(input);
    const walletId = requiredUuid(payload, "walletId");
    const money = requiredMoney(payload, "money");
    const resultBalance = requiredMoney(payload, "resultBalance");
    validateWagerAggregate(envelope.aggregateId, walletId);
    if (money.currency !== resultBalance.currency) {
      return invalid("money and resultBalance currencies must match");
    }

    return {
      ...envelope,
      eventType: "WagerTransactionProcessed",
      eventVersion: INTEGRATION_EVENT_VERSION,
      payload: {
        transactionId: requiredUuid(payload, "transactionId"),
        providerId: requiredString(payload, "providerId", 128),
        externalTransactionId: requiredString(
          payload,
          "externalTransactionId",
          255,
        ),
        playerId: requiredUuid(payload, "playerId"),
        walletId,
        roundId: requiredString(payload, "roundId", 255),
        gameId: requiredString(payload, "gameId", 255),
        kind: requiredKind(payload),
        money,
        resultBalance,
      },
    };
  }

  if (input.eventType === "WagerTransactionRejected") {
    const envelope = requiredEnvelope(input, "WagerTransactionRejected");
    const payload = requiredPayload(input);
    const walletId = requiredUuid(payload, "walletId");
    const money = requiredMoney(payload, "money");
    const resultBalance = requiredMoney(payload, "resultBalance");
    validateWagerAggregate(envelope.aggregateId, walletId);

    return {
      ...envelope,
      eventType: "WagerTransactionRejected",
      eventVersion: INTEGRATION_EVENT_VERSION,
      payload: {
        transactionId: requiredUuid(payload, "transactionId"),
        providerId: requiredString(payload, "providerId", 128),
        externalTransactionId: requiredString(
          payload,
          "externalTransactionId",
          255,
        ),
        playerId: requiredUuid(payload, "playerId"),
        walletId,
        roundId: requiredString(payload, "roundId", 255),
        gameId: requiredString(payload, "gameId", 255),
        kind: requiredKind(payload),
        money,
        resultBalance,
        failureCode: requiredString(payload, "failureCode", 64),
      },
    };
  }

  if (input.eventType === "WalletBalanceChanged") {
    const envelope = requiredEnvelope(input, "WalletBalanceChanged");
    const payload = requiredPayload(input);
    const walletId = requiredUuid(payload, "walletId");
    const previousBalance = requiredMoney(payload, "previousBalance");
    const balance = requiredMoney(payload, "balance");
    validateWagerAggregate(envelope.aggregateId, walletId);
    if (previousBalance.currency !== balance.currency) {
      return invalid("previousBalance and balance currencies must match");
    }

    return {
      ...envelope,
      eventType: "WalletBalanceChanged",
      eventVersion: INTEGRATION_EVENT_VERSION,
      payload: {
        transactionId: requiredUuid(payload, "transactionId"),
        walletId,
        playerId: requiredUuid(payload, "playerId"),
        previousBalance,
        balance,
      },
    };
  }

  return invalid("eventType is not supported");
}
