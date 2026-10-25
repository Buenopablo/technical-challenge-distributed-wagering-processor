import { describe, expect, test } from "bun:test";
import {
  InvalidWagerTransactionMessageError,
  parseWagerTransactionMessage,
  WagerTransactionMessage,
} from "../../src/messaging/contracts/wager-transaction-message";
import {
  InvalidIntegrationEventError,
  parseWagerIntegrationEvent,
  WalletBalanceChangedEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
} from "../../src/messaging/contracts/integration-event";

const validMessage = {
  messageId: "request-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-10-24T20:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
} satisfies WagerTransactionMessage;

const processedEvent = {
  eventId: "0192f298-345e-7e38-af88-e43f851a819d",
  eventType: "WagerTransactionProcessed",
  eventVersion: 1,
  occurredAt: "2026-10-24T20:00:00.000Z",
  aggregateId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  causationId: "sqs-message-123",
  correlationId: "request-123",
  payload: {
    transactionId: "0192f298-345e-7e38-af88-e43f851a819d",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    resultBalance: { amount: "975.00", currency: "BRL" },
  },
} satisfies WagerTransactionProcessedEvent;

const rejectedEvent = {
  ...processedEvent,
  eventId: "0192f298-345e-7e38-af88-e43f851a819e",
  eventType: "WagerTransactionRejected",
  payload: {
    ...processedEvent.payload,
    failureCode: "INSUFFICIENT_FUNDS",
  },
} satisfies WagerTransactionRejectedEvent;

const balanceChangedEvent = {
  eventId: "0192f298-345e-7e38-af88-e43f851a819f",
  eventType: "WalletBalanceChanged",
  eventVersion: 1,
  occurredAt: "2026-10-24T20:00:00Z",
  aggregateId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  payload: {
    transactionId: "0192f298-345e-7e38-af88-e43f851a819d",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    previousBalance: { amount: "100.00", currency: "BRL" },
    balance: { amount: "75.00", currency: "BRL" },
  },
} satisfies WalletBalanceChangedEvent;

describe("SQS wager message contract", () => {
  test("parses the official request envelope and normalizes Money exactly", () => {
    expect(parseWagerTransactionMessage(validMessage)).toEqual(validMessage);
  });

  test("rejects unsupported types, invalid timestamps, and wager kinds", () => {
    expect(() =>
      parseWagerTransactionMessage({ ...validMessage, type: "Unknown" }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        occurredAt: "2026-02-30T20:00:00.000Z",
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: { ...validMessage.data, kind: "OPENING" },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
  });

  test("rejects unknown fields at every contract level", () => {
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        extra: "not part of the contract",
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: { ...validMessage.data, extra: true },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: {
          ...validMessage.data,
          money: { ...validMessage.data.money, precision: 2 },
        },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
  });

  test("rejects malformed identity, idempotency, and money fields", () => {
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: { ...validMessage.data, idempotencyKey: " " },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: {
          ...validMessage.data,
          playerId: "not-a-uuid",
        },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: {
          ...validMessage.data,
          money: { amount: "1e2", currency: "BRL" },
        },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: {
          ...validMessage.data,
          walletId: "not-a-uuid",
        },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: {
          ...validMessage.data,
          money: { amount: "25.00", currency: "ZZZ" },
        },
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
    const { gameId: _gameId, ...missingRequiredField } =
      validMessage.data;
    expect(() =>
      parseWagerTransactionMessage({
        ...validMessage,
        data: missingRequiredField,
      }),
    ).toThrow(InvalidWagerTransactionMessageError);
  });

  test("validates and serializes each outgoing event contract", () => {
    for (const event of [
      processedEvent,
      rejectedEvent,
      balanceChangedEvent,
    ]) {
      const serialized = JSON.stringify(event);
      expect(parseWagerIntegrationEvent(JSON.parse(serialized))).toEqual(event);
    }
    expect(processedEvent.payload.money.amount).toBe("25.00");
  });

  test("rejects malformed common envelope fields and aggregate references", () => {
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        eventId: "not-a-uuid",
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        eventVersion: 2,
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        eventType: "UnknownEvent",
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        occurredAt: "2026-02-30T20:00:00.000Z",
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        aggregateId: "0192f291-27dd-7d3f-8071-5f8685deef38",
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...rejectedEvent,
        payload: { ...rejectedEvent.payload, failureCode: " " },
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        payload: { ...processedEvent.payload, kind: "OPENING" },
      }),
    ).toThrow(InvalidIntegrationEventError);
    const { gameId: _gameId, ...missingProcessedField } =
      processedEvent.payload;
    expect(() =>
      parseWagerIntegrationEvent({
        ...processedEvent,
        payload: missingProcessedField,
      }),
    ).toThrow(InvalidIntegrationEventError);
    const { failureCode: _failureCode, ...missingRejectedField } =
      rejectedEvent.payload;
    expect(() =>
      parseWagerIntegrationEvent({
        ...rejectedEvent,
        payload: missingRejectedField,
      }),
    ).toThrow(InvalidIntegrationEventError);
    const { previousBalance: _previousBalance, ...missingBalanceField } =
      balanceChangedEvent.payload;
    expect(() =>
      parseWagerIntegrationEvent({
        ...balanceChangedEvent,
        payload: missingBalanceField,
      }),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      parseWagerIntegrationEvent({
        ...balanceChangedEvent,
        payload: {
          ...balanceChangedEvent.payload,
          balance: { amount: "75.00", currency: "USD" },
        },
      }),
    ).toThrow(InvalidIntegrationEventError);
  });

  test("allows a rejected transaction snapshot in the wallet currency", () => {
    const mismatchedCurrencyRejection = {
      ...rejectedEvent,
      payload: {
        ...rejectedEvent.payload,
        money: { amount: "10.00", currency: "BRL" },
        resultBalance: { amount: "100.00", currency: "USD" },
      },
    };
    expect(
      parseWagerIntegrationEvent(mismatchedCurrencyRejection),
    ).toMatchObject({
      eventType: "WagerTransactionRejected",
      payload: {
        money: { currency: "BRL" },
        resultBalance: { currency: "USD" },
      },
    });
  });
});
