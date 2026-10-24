import {
  Money,
  MoneyProps,
  MoneyValidationError,
} from "../../domain/money/money";

export const WAGER_MESSAGE_VERSION = 1 as const;

export type WagerMessageKind = "BET" | "WIN" | "LOSS";

export interface WagerTransactionMessage {
  messageVersion: typeof WAGER_MESSAGE_VERSION;
  idempotencyKey: string;
  correlationId?: string;
  transaction: {
    providerId: string;
    externalTransactionId: string;
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

function isWagerMessageKind(value: unknown): value is WagerMessageKind {
  return value === "BET" || value === "WIN" || value === "LOSS";
}

export function parseWagerTransactionMessage(
  input: unknown,
): WagerTransactionMessage {
  if (!isRecord(input)) {
    throw new InvalidWagerTransactionMessageError(
      "Message must be a JSON object",
    );
  }
  if (input.messageVersion !== WAGER_MESSAGE_VERSION) {
    throw new InvalidWagerTransactionMessageError(
      `messageVersion must be ${WAGER_MESSAGE_VERSION}`,
    );
  }

  const idempotencyKey = requiredString(input, "idempotencyKey", 255);
  const correlationId =
    input.correlationId === undefined
      ? undefined
      : requiredString(input, "correlationId", 255);

  if (!isRecord(input.transaction)) {
    throw new InvalidWagerTransactionMessageError(
      "transaction must be a JSON object",
    );
  }
  const transaction = input.transaction;
  const providerId = requiredString(transaction, "providerId", 128);
  const externalTransactionId = requiredString(
    transaction,
    "externalTransactionId",
    255,
  );
  const playerId = requiredString(transaction, "playerId", 36);
  const walletId = requiredString(transaction, "walletId", 36);
  const roundId = requiredString(transaction, "roundId", 255);
  const gameId = requiredString(transaction, "gameId", 255);
  if (!isUuid(playerId) || !isUuid(walletId)) {
    throw new InvalidWagerTransactionMessageError(
      "playerId and walletId must be UUIDs",
    );
  }

  if (!isWagerMessageKind(transaction.kind)) {
    throw new InvalidWagerTransactionMessageError(
      "kind must be BET, WIN, or LOSS in this processing stage",
    );
  }
  if (!isRecord(transaction.money)) {
    throw new InvalidWagerTransactionMessageError(
      "money must contain amount and currency",
    );
  }

  const amount = transaction.money.amount;
  const currency = transaction.money.currency;
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
    messageVersion: WAGER_MESSAGE_VERSION,
    idempotencyKey,
    ...(correlationId === undefined ? {} : { correlationId }),
    transaction: {
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind: transaction.kind,
      money,
    },
  };
}
