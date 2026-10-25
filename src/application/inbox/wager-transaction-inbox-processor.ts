import { createHash } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import {
  IdempotencyConflictError,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
  WagerWalletNotFoundError,
} from "../wagering/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction";
import {
  InvalidWagerTransactionMessageError,
  parseWagerTransactionMessage,
  WagerTransactionMessage,
} from "../../messaging/contracts/wager-transaction-message";

export const WAGER_TRANSACTION_CONSUMER_NAME = "wager-transaction-consumer";

export class InboxMessageIntegrityConflictError extends Error {
  constructor(readonly messageId: string) {
    super(`SQS message ${messageId} was received with different content`);
    this.name = "InboxMessageIntegrityConflictError";
  }
}

export class PermanentWagerProcessingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentWagerProcessingError";
  }
}

export interface ProcessedWagerMessage {
  messageId: string;
  duplicate: boolean;
  result?: ProcessWagerTransactionResult;
  terminalConflict?: true;
}

interface InboxRow {
  payload_hash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function hashWagerTransactionMessage(
  message: WagerTransactionMessage,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(message)))
    .digest("hex");
}

export function parseWagerTransactionMessageBody(
  body: string,
): WagerTransactionMessage {
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch (error) {
    throw new InvalidWagerTransactionMessageError(
      "SQS message body is not valid JSON",
    );
  }
  return parseWagerTransactionMessage(input);
}

function toUseCaseInput(
  message: WagerTransactionMessage,
): ProcessWagerTransactionInput {
  return {
    idempotencyKey: message.data.idempotencyKey,
    providerId: message.data.providerId,
    externalTransactionId: message.data.externalTransactionId,
    playerId: message.data.playerId,
    walletId: message.data.walletId,
    roundId: message.data.roundId,
    gameId: message.data.gameId,
    kind:
      message.data.kind === "BET"
        ? WagerTransactionKind.Bet
        : message.data.kind === "WIN"
          ? WagerTransactionKind.Win
          : WagerTransactionKind.Loss,
    money: message.data.money,
  };
}

export class WagerTransactionInboxProcessor {
  constructor(
    private readonly dataSource: DataSource,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly consumerName = WAGER_TRANSACTION_CONSUMER_NAME,
  ) {
    if (!consumerName.trim() || consumerName.length > 128) {
      throw new Error("SQS consumer name must be 1-128 characters");
    }
  }

  async process(
    transportMessageId: string,
    body: string,
  ): Promise<ProcessedWagerMessage> {
    if (!transportMessageId.trim() || transportMessageId.length > 256) {
      throw new PermanentWagerProcessingError(
        "SQS MessageId must be a non-empty string of at most 256 characters",
      );
    }

    const message = parseWagerTransactionMessageBody(body);
    const payloadHash = hashWagerTransactionMessage(message);

    return this.dataSource.transaction(async (manager) => {
      return this.processInTransaction(
        manager,
        transportMessageId,
        message,
        payloadHash,
      );
    });
  }

  private async processInTransaction(
    manager: EntityManager,
    transportMessageId: string,
    message: WagerTransactionMessage,
    payloadHash: string,
  ): Promise<ProcessedWagerMessage> {
    const inserted = (await manager.query(
      `INSERT INTO inbox_messages (
         consumer_name, message_id, payload_hash
       )
       VALUES ($1, $2, $3)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [this.consumerName, transportMessageId, payloadHash],
    )) as Array<{ message_id: string }>;

    if (inserted.length === 0) {
      const existing = (await manager.query(
        `SELECT payload_hash
         FROM inbox_messages
         WHERE consumer_name = $1 AND message_id = $2
         FOR UPDATE`,
        [this.consumerName, transportMessageId],
      )) as InboxRow[];

      if (existing.length !== 1) {
        throw new Error(
          `Inbox row disappeared for SQS message ${transportMessageId}`,
        );
      }
      if (existing[0].payload_hash.trim() !== payloadHash) {
        throw new InboxMessageIntegrityConflictError(transportMessageId);
      }
      return { messageId: transportMessageId, duplicate: true };
    }

    let result: ProcessWagerTransactionResult;
    try {
      result = await this.useCase.executeInTransaction(
        toUseCaseInput(message),
        manager,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return {
          messageId: transportMessageId,
          duplicate: false,
          terminalConflict: true,
        };
      }
      if (error instanceof WagerWalletNotFoundError) {
        throw new PermanentWagerProcessingError(
          "The wager references a wallet that does not exist",
          { cause: error },
        );
      }
      throw error;
    }

    const updated = (await manager.query(
      `UPDATE inbox_messages
       SET processed_at = clock_timestamp()
       WHERE consumer_name = $1
         AND message_id = $2
         AND payload_hash = $3
       RETURNING message_id`,
      [this.consumerName, transportMessageId, payloadHash],
    )) as [Array<{ message_id: string }>, number];

    if (updated[0].length !== 1) {
      throw new Error(
        `Could not mark SQS message ${transportMessageId} as processed`,
      );
    }

    return { messageId: transportMessageId, duplicate: false, result };
  }
}
