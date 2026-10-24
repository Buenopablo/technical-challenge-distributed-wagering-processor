import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotImplementedException,
  NotFoundException,
  Post,
} from "@nestjs/common";
import {
  IdempotencyConflictError,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
  WagerWalletNotFoundError,
} from "../application/wagering/process-wager-transaction.use-case";
import { MoneyValidationError } from "../domain/money/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction/wager-transaction";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): ProcessWagerTransactionInput {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new BadRequestException("Idempotency-Key header is required");
  }
  if (idempotencyKey.length > 255) {
    throw new BadRequestException("Idempotency-Key exceeds 255 characters");
  }
  if (!isRecord(body)) {
    throw new BadRequestException("Request body must be a JSON object");
  }

  const providerId = requiredString(body, "providerId", 128);
  const externalTransactionId = requiredString(
    body,
    "externalTransactionId",
    255,
  );
  const playerId = requiredString(body, "playerId", 36);
  const walletId = requiredString(body, "walletId", 36);
  const roundId = requiredString(body, "roundId", 255);
  const gameId = requiredString(body, "gameId", 255);
  if (!isUuid(playerId) || !isUuid(walletId)) {
    throw new BadRequestException("playerId and walletId must be UUIDs");
  }

  const kind = body.kind;
  if (
    kind !== WagerTransactionKind.Bet &&
    kind !== WagerTransactionKind.Win &&
    kind !== WagerTransactionKind.Loss &&
    kind !== WagerTransactionKind.Refund &&
    kind !== WagerTransactionKind.Rollback
  ) {
    throw new BadRequestException(
      "kind must be a supported transaction kind from the challenge",
    );
  }
  if (!isRecord(body.money)) {
    throw new BadRequestException("money must contain amount and currency");
  }
  const { amount, currency } = body.money;
  if (typeof amount !== "string" || typeof currency !== "string") {
    throw new BadRequestException("money.amount and money.currency must be strings");
  }
  if (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
  ) {
    throw new NotImplementedException(
      `${kind} is part of the challenge contract but is not implemented yet`,
    );
  }

  return {
    idempotencyKey,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money: { amount, currency },
  };
}

@Controller("wagering/transactions")
export class WagerTransactionsController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const input = parseRequest(body, idempotencyKey);

    let result: ProcessWagerTransactionResult;
    try {
      result = await this.processWagerTransaction.execute(input);
    } catch (error) {
      if (error instanceof MoneyValidationError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof WagerWalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }

    if (result.status === WagerTransactionStatus.Rejected) {
      throw new HttpException(
        {
          transactionId: result.transactionId,
          status: result.status,
          balance: result.balance,
          idempotentReplay: result.idempotentReplay,
          failureCode: result.failureCode,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };
  }
}
