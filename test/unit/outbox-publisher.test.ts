import { describe, expect, test } from "bun:test";
import { calculateOutboxRetryDelayMs } from "../../src/application/outbox/outbox-publisher";
import { reconstructOutboxEvent } from "../../src/application/outbox/outbox-event";
import {
  classifySqsPublishError,
  readSqsPublisherConfig,
} from "../../src/messaging/sqs/sqs-publisher-client";

describe("Outbox publisher helpers", () => {
  test("reconstructs and validates the integration envelope from Outbox columns", () => {
    const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
    const event = reconstructOutboxEvent({
      event_id: "0192f298-345e-7e38-af88-e43f851a819d",
      event_type: "WalletBalanceChanged",
      event_version: 1,
      aggregate_id: walletId,
      occurred_at: new Date("2026-10-25T12:00:00.000Z"),
      causation_id: null,
      correlation_id: "correlation-1",
      payload: {
        transactionId: "0192f298-345e-7e38-af88-e43f851a819d",
        walletId,
        playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
        previousBalance: { amount: "1.00", currency: "BRL" },
        balance: { amount: "2.00", currency: "BRL" },
      },
    });

    expect(event).toMatchObject({
      eventType: "WalletBalanceChanged",
      eventVersion: 1,
      aggregateId: walletId,
      occurredAt: "2026-10-25T12:00:00.000Z",
      correlationId: "correlation-1",
      payload: {
        previousBalance: { amount: "1.00", currency: "BRL" },
        balance: { amount: "2.00", currency: "BRL" },
      },
    });
    expect(JSON.stringify(event)).not.toContain("causationId");
  });

  test("rejects malformed persisted events", () => {
    expect(() =>
      reconstructOutboxEvent({
        event_id: "not-a-uuid",
        event_type: "WalletBalanceChanged",
        event_version: 1,
        aggregate_id: "not-a-uuid",
        occurred_at: new Date(),
        causation_id: null,
        correlation_id: null,
        payload: {},
      }),
    ).toThrow(/eventId must be a UUID/);
  });

  test("uses exponential jitter with the configured five-minute ceiling", () => {
    expect(calculateOutboxRetryDelayMs(1, () => 0)).toBe(500);
    expect(calculateOutboxRetryDelayMs(1, () => 1)).toBe(1_500);
    expect(calculateOutboxRetryDelayMs(10, () => 1)).toBe(300_000);
    expect(calculateOutboxRetryDelayMs(0, () => 0.5)).toBe(1_000);
  });

  test("validates the output FIFO queue and LocalStack endpoint configuration", () => {
    expect(
      readSqsPublisherConfig({
        AWS_REGION: "us-east-2",
        SQS_ENDPOINT: "http://127.0.0.1:14566",
        SQS_WAGER_INTEGRATION_EVENTS_QUEUE: "events.fifo",
      }),
    ).toEqual({
      region: "us-east-2",
      endpoint: "http://127.0.0.1:14566",
      queueName: "events.fifo",
    });
    expect(() =>
      readSqsPublisherConfig({
        SQS_WAGER_INTEGRATION_EVENTS_QUEUE: "events",
      }),
    ).toThrow(/must name a FIFO queue/);
    expect(() =>
      readSqsPublisherConfig({
        SQS_ENDPOINT: "ftp://localhost:14566",
      }),
    ).toThrow(/valid HTTP\(S\) URL/);
  });

  test("classifies known SQS failures and leaves unknown codes unclassified", () => {
    expect(
      classifySqsPublishError(
        Object.assign(new Error("missing queue"), {
          name: "QueueDoesNotExist",
        }),
      ),
    ).toBe("global-configuration");
    expect(
      classifySqsPublishError(
        Object.assign(new Error("incompatible request parameters"), {
          Code: "InvalidParameterValue",
        }),
      ),
    ).toBe("global-configuration");
    expect(
      classifySqsPublishError(
        Object.assign(new Error("invalid body"), {
          Code: "InvalidMessageContents",
        }),
      ),
    ).toBe("permanent-message");
    expect(
      classifySqsPublishError(
        Object.assign(new Error("service unavailable"), {
          name: "ServiceUnavailable",
        }),
      ),
    ).toBe("transient");
    expect(
      classifySqsPublishError(
        Object.assign(new Error("unknown response"), {
          name: "FutureAwsErrorCode",
        }),
      ),
    ).toBe("unknown");
    expect(
      classifySqsPublishError(
        Object.assign(new Error("service failure"), {
          $metadata: { httpStatusCode: 503 },
        }),
      ),
    ).toBe("transient");
    expect(
      classifySqsPublishError(
        Object.assign(new Error("connection reset"), {
          code: "ECONNRESET",
        }),
      ),
    ).toBe("transient");
  });
});
