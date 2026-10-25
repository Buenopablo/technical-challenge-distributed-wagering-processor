import { randomUUID } from "node:crypto";
import { MoneyProps } from "../../domain/money/money";
import { WagerMessageKind } from "../../messaging/contracts/wager-transaction-message";
import {
  parseWagerIntegrationEvent,
  WagerIntegrationEvent,
} from "../../messaging/contracts/integration-event";

type WagerEventResult =
  | { status: "PROCESSED" }
  | { status: "REJECTED"; failureCode: string };

export interface CreateWagerIntegrationEventsInput {
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
  previousBalance?: MoneyProps;
  occurredAt: Date;
  result: WagerEventResult;
}

export function createWagerIntegrationEvents(
  input: CreateWagerIntegrationEventsInput,
): WagerIntegrationEvent[] {
  const envelope = {
    eventVersion: 1 as const,
    occurredAt: input.occurredAt.toISOString(),
    aggregateId: input.walletId,
  };
  const transactionPayload = {
    transactionId: input.transactionId,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    resultBalance: input.resultBalance,
  };
  const candidates: unknown[] = [
    input.result.status === "PROCESSED"
      ? {
          ...envelope,
          eventId: randomUUID(),
          eventType: "WagerTransactionProcessed",
          payload: transactionPayload,
        }
      : {
          ...envelope,
          eventId: randomUUID(),
          eventType: "WagerTransactionRejected",
          payload: {
            ...transactionPayload,
            failureCode: input.result.failureCode,
          },
        },
  ];

  if (input.previousBalance) {
    candidates.push({
      ...envelope,
      eventId: randomUUID(),
      eventType: "WalletBalanceChanged",
      payload: {
        transactionId: input.transactionId,
        walletId: input.walletId,
        playerId: input.playerId,
        previousBalance: input.previousBalance,
        balance: input.resultBalance,
      },
    });
  }

  return candidates.map(parseWagerIntegrationEvent);
}
