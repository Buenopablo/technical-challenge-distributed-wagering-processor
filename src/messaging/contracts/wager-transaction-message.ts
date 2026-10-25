import {
  Money,
  MoneyProps,
  MoneyValidationError,
} from "../../domain/money/money";

export const WAGER_TRANSACTION_REQUESTED_TYPE = "WagerTransactionRequested";
export type WagerMessageKind = "BET" | "WIN" | "LOSS";

export interface WagerTransactionMessage {
  messageId: string;
  type: typeof WAGER_TRANSACTION_REQUESTED_TYPE;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerMessageKind;
    money: MoneyProps;
  };
}

export class InvalidWagerTransactionMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionMessageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  objectName: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new InvalidWagerTransactionMessageError(
      `${objectName} contains unsupported field(s): ${unknown.join(", ")}`,
    );
  }
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    candidate.length > maxLength
  ) {
    throw new InvalidWagerTransactionMessageError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return candidate;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseOccurredAt(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    throw new InvalidWagerTransactionMessageError(
      "occurredAt must be an ISO-8601 UTC timestamp",
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidWagerTransactionMessageError(
      "occurredAt must be a valid ISO-8601 UTC timestamp",
    );
  }
  const parts = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  if (
    !parts ||
    date.toISOString() !== `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0")}Z`
  ) {
    throw new InvalidWagerTransactionMessageError(
      "occurredAt must be a valid ISO-8601 UTC timestamp",
    );
  }
  return value;
}

export function parseWagerTransactionMessage(
  input: unknown,
): WagerTransactionMessage {
  if (!isRecord(input)) {
    throw new InvalidWagerTransactionMessageError(
      "Message must be a JSON object",
    );
  }
  rejectUnknownFields(
    input,
    ["messageId", "type", "occurredAt", "data"],
    "Message",
  );
  if (input.type !== WAGER_TRANSACTION_REQUESTED_TYPE) {
    throw new InvalidWagerTransactionMessageError(
      `type must be ${WAGER_TRANSACTION_REQUESTED_TYPE}`,
    );
  }
  if (!isRecord(input.data)) {
    throw new InvalidWagerTransactionMessageError(
      "data must be a JSON object",
    );
  }
  rejectUnknownFields(
    input.data,
    [
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
      "kind",
      "money",
    ],
    "data",
  );

  const messageId = requiredString(input, "messageId", 256);
  const occurredAt = parseOccurredAt(input.occurredAt);
  const data = input.data;
  const providerId = requiredString(data, "providerId", 128);
  const externalTransactionId = requiredString(
    data,
    "externalTransactionId",
    255,
  );
  const idempotencyKey = requiredString(data, "idempotencyKey", 255);
  const playerId = requiredString(data, "playerId", 36);
  const walletId = requiredString(data, "walletId", 36);
  const roundId = requiredString(data, "roundId", 255);
  const gameId = requiredString(data, "gameId", 255);
  if (!isUuid(playerId) || !isUuid(walletId)) {
    throw new InvalidWagerTransactionMessageError(
      "playerId and walletId must be UUIDs",
    );
  }

  const kind = data.kind;
  if (kind !== "BET" && kind !== "WIN" && kind !== "LOSS") {
    throw new InvalidWagerTransactionMessageError(
      "kind must be BET, WIN, or LOSS in this processing stage",
    );
  }
  if (!isRecord(data.money)) {
    throw new InvalidWagerTransactionMessageError(
      "money must contain amount and currency",
    );
  }
  rejectUnknownFields(data.money, ["amount", "currency"], "money");
  const amount = data.money.amount;
  const currency = data.money.currency;
  if (typeof amount !== "string" || typeof currency !== "string") {
    throw new InvalidWagerTransactionMessageError(
      "money.amount and money.currency must be strings",
    );
  }

  let money: MoneyProps;
  try {
    money = Money.from({ amount, currency }).toJSON();
  } catch (error) {
    if (error instanceof MoneyValidationError) {
      throw new InvalidWagerTransactionMessageError(error.message);
    }
    throw error;
  }

  return {
    messageId,
    type: WAGER_TRANSACTION_REQUESTED_TYPE,
    occurredAt,
    data: {
      providerId,
      externalTransactionId,
      idempotencyKey,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money,
    },
  };
}
