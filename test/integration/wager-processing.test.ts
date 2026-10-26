import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { OpenWalletUseCase } from "../../src/application/wallets/open-wallet.use-case";
import {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
} from "../../src/application/wagering/process-wager-transaction.use-case";
import { createDatabaseOptions } from "../../src/database/data-source";
import { WagerTransactionKind } from "../../src/domain/wager-transaction/wager-transaction";
import { WagerTransactionsController } from "../../src/http/wager-transactions.controller";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import {
  parseWagerIntegrationEvent,
  WagerIntegrationEvent,
} from "../../src/messaging/contracts/integration-event";

let testDataSource: DataSource | undefined;
let adminDataSource: DataSource | undefined;
let testDatabaseName: string | undefined;
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
let baseUrl: string | undefined;

function getTestDataSource(): DataSource {
  if (!testDataSource) {
    throw new Error("The PostgreSQL integration-test database is not ready");
  }
  return testDataSource;
}

function getBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("The wager HTTP integration server is not ready");
  }
  return baseUrl;
}

async function startIndependentWagerApp(
  database: string,
): Promise<{
  app: Awaited<ReturnType<typeof NestFactory.create>>;
  baseUrl: string;
}> {
  const options = createDatabaseOptions();
  if (options.type !== "postgres") {
    throw new Error("Integration tests require PostgreSQL");
  }

  class IndependentWagerApiIntegrationModule {}
  Module({
    imports: [
      TypeOrmModule.forRoot({
        ...options,
        database,
      }),
    ],
    controllers: [WagerTransactionsController],
    providers: [ProcessWagerTransactionUseCase],
  })(IndependentWagerApiIntegrationModule);

  const independentApp = await NestFactory.create(
    IndependentWagerApiIntegrationModule,
    { logger: false },
  );
  await independentApp.listen(0, "127.0.0.1");
  const address = independentApp.getHttpServer().address() as AddressInfo;
  return {
    app: independentApp,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function createWallet(balance: string) {
  return new OpenWalletUseCase(getTestDataSource()).execute({
    playerId: randomUUID(),
    initialBalance: { amount: balance, currency: "BRL" },
  });
}

function requestBody(
  wallet: { id: string; playerId: string },
  kind:
    | WagerTransactionKind.Bet
    | WagerTransactionKind.Win
    | WagerTransactionKind.Loss
    | WagerTransactionKind.Refund
    | WagerTransactionKind.Rollback,
  amount: string,
  referenceExternalTransactionId?: string,
): Omit<ProcessWagerTransactionInput, "idempotencyKey"> {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: { amount, currency: "BRL" },
    ...(referenceExternalTransactionId
      ? { referenceExternalTransactionId }
      : {}),
  };
}

function submit(
  idempotencyKey: string,
  body: object,
): Promise<Response> {
  return fetch(`${getBaseUrl()}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function submitTo(
  url: string,
  idempotencyKey: string,
  body: object,
): Promise<Response> {
  return fetch(`${url}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function countRows(
  table: "wager_transactions" | "wallet_ledger_entries",
  walletId: string,
): Promise<number> {
  const [row] = await getTestDataSource().query(
    `SELECT count(*)::int AS count FROM ${table} WHERE wallet_id = $1`,
    [walletId],
  );
  return row.count as number;
}

async function countByValue(
  table: "wager_transactions" | "wallet_ledger_entries",
  column: "kind" | "direction",
  value: string,
  walletId: string,
): Promise<number> {
  const [row] = await getTestDataSource().query(
    `SELECT count(*)::int AS count FROM ${table} WHERE wallet_id = $1 AND ${column} = $2`,
    [walletId, value],
  );
  return row.count as number;
}

async function outboxEventsForTransaction(
  transactionId: string,
): Promise<WagerIntegrationEvent[]> {
  const rows = (await getTestDataSource().query(
    `SELECT event_id, event_type, event_version, aggregate_id, occurred_at,
            causation_id, correlation_id, payload
     FROM outbox_messages
     WHERE payload ->> 'transactionId' = $1
     ORDER BY event_type`,
    [transactionId],
  )) as Array<{
    event_id: string;
    event_type: string;
    event_version: number;
    aggregate_id: string;
    occurred_at: Date;
    causation_id: string | null;
    correlation_id: string | null;
    payload: Record<string, unknown>;
  }>;

  return rows.map((row) =>
    parseWagerIntegrationEvent({
      eventId: row.event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      occurredAt: row.occurred_at.toISOString(),
      aggregateId: row.aggregate_id,
      ...(row.causation_id ? { causationId: row.causation_id } : {}),
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      payload: row.payload,
    }),
  );
}

function transactionIdFrom(body: Record<string, unknown>): string {
  if (typeof body.transactionId !== "string") {
    throw new Error("Expected a transactionId in the HTTP response");
  }
  return body.transactionId;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Expected the HTTP response body to be a JSON object");
  }
  return body as Record<string, unknown>;
}

describe("wager transaction HTTP and PostgreSQL integration", () => {
  beforeAll(async () => {
    const options = createDatabaseOptions();
    if (options.type !== "postgres") {
      throw new Error("Integration tests require PostgreSQL");
    }

    testDatabaseName = `jungle_wagering_test_${randomUUID().replaceAll("-", "")}`;
    adminDataSource = new DataSource({
      ...options,
      database: "postgres",
      entities: [],
      migrations: [],
    });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE DATABASE "${testDatabaseName}"`);

    testDataSource = new DataSource({
      ...options,
      database: testDatabaseName,
    });
    await testDataSource.initialize();
    await testDataSource.runMigrations();

    class WagerApiIntegrationModule {}
    Module({
      imports: [
        TypeOrmModule.forRoot({
          ...options,
          database: testDatabaseName,
        }),
      ],
      controllers: [WagerTransactionsController],
      providers: [ProcessWagerTransactionUseCase],
    })(WagerApiIntegrationModule);

    app = await NestFactory.create(WagerApiIntegrationModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (testDataSource?.isInitialized) {
      await testDataSource.destroy();
    }
    if (adminDataSource?.isInitialized && testDatabaseName) {
      await adminDataSource.query(`DROP DATABASE "${testDatabaseName}"`);
      await adminDataSource.destroy();
    }
  });

  test("processes BET, WIN, and LOSS using the documented transaction effects", async () => {
    const wallet = await createWallet("100.00");
    const betBody = requestBody(wallet, WagerTransactionKind.Bet, "25.00");
    const betResponse = await submit("provider-a:bet-1", betBody);
    expect(betResponse.status).toBe(200);
    const betResult = await responseBody(betResponse);
    expect(betResult).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: false,
    });
    await expect(
      getTestDataSource().query(
        "UPDATE wager_transactions SET result_balance = NULL, result_currency = NULL WHERE id = $1",
        [betResult.transactionId],
      ),
    ).rejects.toThrow(/ck_wager_transactions_terminal_result_snapshot/);

    const winResponse = await submit(
      "provider-a:win-1",
      requestBody(wallet, WagerTransactionKind.Win, "10.00"),
    );
    expect(winResponse.status).toBe(200);
    const winResult = await responseBody(winResponse);
    expect(winResult).toMatchObject({
      balance: { amount: "85.00", currency: "BRL" },
    });

    const lossResponse = await submit(
      "provider-a:loss-1",
      requestBody(wallet, WagerTransactionKind.Loss, "10.00"),
    );
    expect(lossResponse.status).toBe(200);
    const lossResult = await responseBody(lossResponse);
    expect(lossResult).toMatchObject({
      balance: { amount: "85.00", currency: "BRL" },
    });
    expect(
      await countByValue("wallet_ledger_entries", "direction", "DEBIT", wallet.id),
    ).toBe(1);
    expect(
      await countByValue("wallet_ledger_entries", "direction", "CREDIT", wallet.id),
    ).toBe(2);

    const betEvents = await outboxEventsForTransaction(
      transactionIdFrom(betResult),
    );
    expect(betEvents).toHaveLength(2);
    expect(betEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "WagerTransactionProcessed",
          payload: expect.objectContaining({
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
            resultBalance: { amount: "75.00", currency: "BRL" },
          }),
        }),
        expect.objectContaining({
          eventType: "WalletBalanceChanged",
          payload: expect.objectContaining({
            previousBalance: { amount: "100.00", currency: "BRL" },
            balance: { amount: "75.00", currency: "BRL" },
          }),
        }),
      ]),
    );

    expect(await outboxEventsForTransaction(transactionIdFrom(winResult))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "WagerTransactionProcessed" }),
        expect.objectContaining({ eventType: "WalletBalanceChanged" }),
      ]),
    );
    const lossEvents = await outboxEventsForTransaction(
      transactionIdFrom(lossResult),
    );
    expect(lossEvents).toHaveLength(1);
    expect(lossEvents[0]).toMatchObject({
      eventType: "WagerTransactionProcessed",
      payload: { kind: "LOSS" },
    });
  });

  test("allows zero without changing balance, version, or ledger", async () => {
    const wallet = await createWallet("10.00");
    const response = await submit(
      "provider-a:zero-bet",
      requestBody(wallet, WagerTransactionKind.Bet, "0.00"),
    );
    expect(response.status).toBe(200);
    const result = await responseBody(response);
    expect(result).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "10.00", currency: "BRL" },
    });

    const [persisted] = await getTestDataSource().query(
      "SELECT version FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(persisted.version).toBe(1);
    expect(await countRows("wallet_ledger_entries", wallet.id)).toBe(1);
    const events = await outboxEventsForTransaction(transactionIdFrom(result));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("WagerTransactionProcessed");
  });

  test("returns the wallet currency in a persisted currency-mismatch rejection", async () => {
    const wallet = await new OpenWalletUseCase(getTestDataSource()).execute({
      playerId: randomUUID(),
      initialBalance: { amount: "10.00", currency: "USD" },
    });
    const body = {
      ...requestBody(wallet, WagerTransactionKind.Win, "2.00"),
      money: { amount: "2.00", currency: "BRL" },
    };
    const response = await submit("provider-a:currency-mismatch", body);
    expect(response.status).toBe(422);
    const originalResponse = await responseBody(response);
    expect(originalResponse).toMatchObject({
      status: "REJECTED",
      balance: { amount: "10.00", currency: "USD" },
      failureCode: "WALLET_CURRENCY_MISMATCH",
    });
    const originalEvents = await outboxEventsForTransaction(
      transactionIdFrom(originalResponse),
    );
    expect(originalEvents).toHaveLength(1);
    expect(originalEvents[0]).toMatchObject({
      eventType: "WagerTransactionRejected",
      payload: {
        failureCode: "WALLET_CURRENCY_MISMATCH",
        money: { amount: "2.00", currency: "BRL" },
        resultBalance: { amount: "10.00", currency: "USD" },
      },
    });

    const replay = await submit("provider-a:currency-mismatch", body);
    expect(replay.status).toBe(422);
    expect(await responseBody(replay)).toMatchObject({
      balance: { amount: "10.00", currency: "USD" },
      idempotentReplay: true,
    });
    expect(
      await outboxEventsForTransaction(transactionIdFrom(originalResponse)),
    ).toEqual(originalEvents);
  });

  test("persists player mismatch rejection without changing wallet or ledger", async () => {
    const wallet = await createWallet("100.00");
    const body = {
      ...requestBody(wallet, WagerTransactionKind.Win, "10.00"),
      playerId: randomUUID(),
    };
    const response = await submit("provider-a:player-mismatch", body);
    expect(response.status).toBe(422);
    const result = await responseBody(response);
    expect(result).toMatchObject({
      status: "REJECTED",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: false,
      failureCode: "WALLET_PLAYER_MISMATCH",
    });

    const [transaction] = await getTestDataSource().query(
      `SELECT status, failure_code, result_balance, result_currency
       FROM wager_transactions WHERE id = $1`,
      [result.transactionId],
    );
    expect(transaction).toEqual({
      status: "REJECTED",
      failure_code: "WALLET_PLAYER_MISMATCH",
      result_balance: "100.00",
      result_currency: "BRL",
    });

    const [persistedWallet] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(persistedWallet.balance).toBe("100.00");
    const [ledgerCount] = await getTestDataSource().query(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = $1",
      [result.transactionId],
    );
    expect(ledgerCount.count).toBe(0);
  });

  test("persists insufficient-funds rejection without partial balance changes", async () => {
    const wallet = await createWallet("100.00");
    const response = await submit(
      "provider-a:insufficient",
      requestBody(wallet, WagerTransactionKind.Bet, "101.00"),
    );
    expect(response.status).toBe(422);
    const body = await responseBody(response);
    expect(body).toMatchObject({
      status: "REJECTED",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: false,
      failureCode: "INSUFFICIENT_FUNDS",
    });
    expect(
      await countByValue("wallet_ledger_entries", "direction", "DEBIT", wallet.id),
    ).toBe(0);

    const [transaction] = await getTestDataSource().query(
      "SELECT status, failure_code, result_balance, result_currency FROM wager_transactions WHERE id = $1",
      [body.transactionId],
    );
    expect(transaction).toEqual({
      status: "REJECTED",
      failure_code: "INSUFFICIENT_FUNDS",
      result_balance: "100.00",
      result_currency: "BRL",
    });
  });

  test("replays a rejected transaction with its original balance snapshot", async () => {
    const wallet = await createWallet("100.00");
    const key = "provider-a:rejected-replay";
    const body = requestBody(wallet, WagerTransactionKind.Bet, "101.00");
    const first = await submit(key, body);
    expect(first.status).toBe(422);
    const originalResponse = await responseBody(first);
    const originalEvents = await outboxEventsForTransaction(
      transactionIdFrom(originalResponse),
    );

    await submit(
      "provider-a:later-credit",
      requestBody(wallet, WagerTransactionKind.Win, "10.00"),
    );
    const replay = await submit(key, body);
    expect(replay.status).toBe(422);
    expect(await responseBody(replay)).toMatchObject({
      status: "REJECTED",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: true,
      failureCode: "INSUFFICIENT_FUNDS",
    });
    expect(
      await outboxEventsForTransaction(transactionIdFrom(originalResponse)),
    ).toEqual(originalEvents);
  });

  test("replays the original balance after the wallet has changed", async () => {
    const wallet = await createWallet("100.00");
    const firstBody = requestBody(wallet, WagerTransactionKind.Win, "10.00");
    const first = await submit("provider-a:replay-first", firstBody);
    const originalResult = await responseBody(first);
    const originalEvents = await outboxEventsForTransaction(
      transactionIdFrom(originalResult),
    );
    await submit(
      "provider-a:replay-second",
      requestBody(wallet, WagerTransactionKind.Win, "5.00"),
    );

    const replay = await submit("provider-a:replay-first", firstBody);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ...originalResult,
      idempotentReplay: true,
    });
    expect(await countRows("wallet_ledger_entries", wallet.id)).toBe(3);
    expect(
      await outboxEventsForTransaction(transactionIdFrom(originalResult)),
    ).toEqual(originalEvents);
  });

  test("returns conflict for a reused key with a different business payload", async () => {
    const wallet = await createWallet("100.00");
    const key = "provider-a:payload-conflict";
    const first = await submit(
      key,
      requestBody(wallet, WagerTransactionKind.Win, "10.00"),
    );
    expect(first.status).toBe(200);
    const firstResult = await responseBody(first);
    const originalEvents = await outboxEventsForTransaction(
      transactionIdFrom(firstResult),
    );

    const conflict = await submit(
      key,
      requestBody(wallet, WagerTransactionKind.Win, "11.00"),
    );
    expect(conflict.status).toBe(409);
    expect(await countByValue("wager_transactions", "kind", "WIN", wallet.id)).toBe(1);
    expect(await countByValue("wallet_ledger_entries", "direction", "CREDIT", wallet.id)).toBe(2);
    expect(
      await outboxEventsForTransaction(transactionIdFrom(firstResult)),
    ).toEqual(originalEvents);
  });

  test("persists missing reversal references and replays the pending result", async () => {
    const wallet = await createWallet("100.00");
    const body = requestBody(wallet, WagerTransactionKind.Bet, "10.00");
    const missingKey = await fetch(`${getBaseUrl()}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(missingKey.status).toBe(400);

    const invalidMoney = await submit("provider-a:invalid-money", {
      ...body,
      money: { amount: "1e2", currency: "BRL" },
    });
    expect(invalidMoney.status).toBe(400);

    const refund = await submit("provider-a:deferred-refund", {
      ...body,
      kind: "REFUND",
      externalTransactionId: "refund-pending-1",
      referenceExternalTransactionId: "missing-bet-1",
    });
    expect(refund.status).toBe(202);
    const pending = await responseBody(refund);
    expect(pending).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: false,
    });

    const replay = await submit("provider-a:deferred-refund", {
      ...body,
      kind: "REFUND",
      externalTransactionId: "refund-pending-1",
      referenceExternalTransactionId: "missing-bet-1",
    });
    expect(replay.status).toBe(202);
    expect(await responseBody(replay)).toMatchObject({
      transactionId: pending.transactionId,
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: true,
    });
    expect(
      await getTestDataSource().query(
        `SELECT event_type FROM outbox_messages
         WHERE payload ->> 'transactionId' = $1`,
        [pending.transactionId],
      ),
    ).toEqual([{ event_type: "WagerTransactionPendingReference" }]);
    await getTestDataSource().query(
      `UPDATE wager_transactions SET reference_next_attempt_at = $1 WHERE id = $2`,
      [new Date(Date.now() + 48 * 60 * 60 * 1000), pending.transactionId],
    );
    const malformedRefund = await submit("provider-a:malformed-refund", {
      ...body,
      kind: "REFUND",
      externalTransactionId: "malformed-refund-1",
      referenceExternalTransactionId: "provider-a:original-bet",
      money: { amount: "1e2", currency: "BRL" },
    });
    expect(malformedRefund.status).toBe(400);
    expect(
      (
        await submit("provider-a:missing-rollback-reference", {
          ...body,
          kind: "ROLLBACK",
          externalTransactionId: "missing-ref-rollback",
        })
      ).status,
    ).toBe(400);
  });

    test("retries pending references and applies the reversal once the reference arrives", async () => {
      const wallet = await createWallet("100.00");
      const referenceExternalTransactionId = "late-reference-bet";
      const refund = requestBody(
        wallet,
        WagerTransactionKind.Refund,
        "20.00",
        referenceExternalTransactionId,
      );
      const accepted = await submit("provider-a:late-refund", refund);
      expect(accepted.status).toBe(202);
      const acceptedBody = await responseBody(accepted);

      const [pending] = await getTestDataSource().query(
        `SELECT reference_next_attempt_at
         FROM wager_transactions WHERE id = $1`,
        [acceptedBody.transactionId],
      );
      const firstAttemptAt = new Date(pending.reference_next_attempt_at);
      const worker = new PendingReferenceWorker(
        getTestDataSource(),
        new ProcessWagerTransactionUseCase(getTestDataSource()),
        { info() {}, warn() {}, error() {} },
      );
      expect(
        await worker.runOnce(new Date(firstAttemptAt.getTime() + 1)),
      ).toBe(1);
      const [rescheduled] = await getTestDataSource().query(
        `SELECT reference_attempts, reference_next_attempt_at, status
         FROM wager_transactions WHERE id = $1`,
        [acceptedBody.transactionId],
      );
      expect(rescheduled).toMatchObject({
        reference_attempts: 1,
        status: "PENDING_REFERENCE",
      });

      const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
      bet.externalTransactionId = referenceExternalTransactionId;
      expect((await submit("provider-a:late-reference-bet", bet)).status).toBe(200);
      const secondAttemptAt = new Date(rescheduled.reference_next_attempt_at);
      expect(
        await worker.runOnce(new Date(secondAttemptAt.getTime() + 1)),
      ).toBe(1);

      const [final] = await getTestDataSource().query(
        `SELECT status, reference_attempts, reference_transaction_id,
                result_balance, failure_code, reference_next_attempt_at
         FROM wager_transactions WHERE id = $1`,
        [acceptedBody.transactionId],
      );
      expect(final).toMatchObject({
        status: "PROCESSED",
        reference_attempts: 2,
        result_balance: "100.00",
        failure_code: null,
        reference_next_attempt_at: null,
      });
      expect(final.reference_transaction_id).toBeTruthy();
      const [walletState] = await getTestDataSource().query(
        "SELECT balance FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(walletState.balance).toBe("100.00");
      expect(
        await countByValue(
          "wallet_ledger_entries",
          "direction",
          "CREDIT",
          wallet.id,
        ),
      ).toBe(2);
    });

    test("rejects a missing reference after the TTL and publishes its terminal event", async () => {
      const wallet = await createWallet("100.00");
      const response = await submit(
        "provider-a:expired-pending-reference",
        requestBody(
          wallet,
          WagerTransactionKind.Rollback,
          "10.00",
          "never-arrived-reference",
        ),
      );
      expect(response.status).toBe(202);
      const body = await responseBody(response);
      const now = new Date();
      await getTestDataSource().query(
        `UPDATE wager_transactions
         SET created_at = $1, reference_next_attempt_at = $2
         WHERE id = $3`,
        [new Date(now.getTime() - 25 * 60 * 60 * 1000), new Date(now.getTime() - 1), body.transactionId],
      );

      const worker = new PendingReferenceWorker(
        getTestDataSource(),
        new ProcessWagerTransactionUseCase(getTestDataSource()),
        { info() {}, warn() {}, error() {} },
      );
      expect(await worker.runOnce(now)).toBe(1);
      const [transaction] = await getTestDataSource().query(
        `SELECT status, failure_code, reference_attempts, result_balance
         FROM wager_transactions WHERE id = $1`,
        [body.transactionId],
      );
      expect(transaction).toEqual({
        status: "REJECTED",
        failure_code: "REFERENCE_NOT_FOUND",
        reference_attempts: 1,
        result_balance: "100.00",
      });
      expect(
        await getTestDataSource().query(
          `SELECT event_type, payload ->> 'failureCode' AS failure_code
           FROM outbox_messages
           WHERE payload ->> 'transactionId' = $1
           ORDER BY event_type`,
          [body.transactionId],
        ),
      ).toEqual([
        {
          event_type: "WagerTransactionPendingReference",
          failure_code: null,
        },
        {
          event_type: "WagerTransactionRejected",
          failure_code: "REFERENCE_NOT_FOUND",
        },
      ]);
      const [walletState] = await getTestDataSource().query(
        "SELECT balance FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(walletState.balance).toBe("100.00");
    });

    test("expires a pending reference even if it becomes available after the TTL", async () => {
      const wallet = await createWallet("100.00");
      const reference = requestBody(wallet, WagerTransactionKind.Bet, "10.00");
      reference.externalTransactionId = "reference-arrived-after-ttl";
      const response = await submit(
        "provider-a:expired-but-resolvable-refund",
        requestBody(
          wallet,
          WagerTransactionKind.Refund,
          "10.00",
          reference.externalTransactionId,
        ),
      );
      expect(response.status).toBe(202);
      const { transactionId } = await responseBody(response);
      expect(
        (await submit("provider-a:late-expired-reference", reference)).status,
      ).toBe(200);
      const now = new Date();
      await getTestDataSource().query(
        `UPDATE wager_transactions
         SET created_at = $1, reference_next_attempt_at = $2
         WHERE id = $3`,
        [
          new Date(now.getTime() - 25 * 60 * 60 * 1000),
          new Date(now.getTime() - 1),
          transactionId,
        ],
      );

      const worker = new PendingReferenceWorker(
        getTestDataSource(),
        new ProcessWagerTransactionUseCase(getTestDataSource()),
        { info() {}, warn() {}, error() {} },
      );
      expect(await worker.runOnce(now)).toBe(1);
      const [transaction] = await getTestDataSource().query(
        "SELECT status, failure_code FROM wager_transactions WHERE id = $1",
        [transactionId],
      );
      expect(transaction).toEqual({
        status: "REJECTED",
        failure_code: "REFERENCE_NOT_FOUND",
      });
      const [walletState] = await getTestDataSource().query(
        "SELECT balance FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(walletState.balance).toBe("90.00");
    });

    test("finalizes a pending reference at the configured attempt limit", async () => {
      const wallet = await createWallet("100.00");
      const response = await submit(
        "provider-a:attempt-limit-pending-reference",
        requestBody(
          wallet,
          WagerTransactionKind.Refund,
          "10.00",
          "attempt-limit-reference",
        ),
      );
      const body = await responseBody(response);
      const now = new Date();
      await getTestDataSource().query(
        `UPDATE wager_transactions
         SET reference_attempts = 7, reference_next_attempt_at = $1
         WHERE id = $2`,
        [new Date(now.getTime() - 1), body.transactionId],
      );
      const worker = new PendingReferenceWorker(
        getTestDataSource(),
        new ProcessWagerTransactionUseCase(getTestDataSource()),
        { info() {}, warn() {}, error() {} },
      );
      expect(await worker.runOnce(now)).toBe(1);
      const [transaction] = await getTestDataSource().query(
        "SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = $1",
        [body.transactionId],
      );
      expect(transaction).toEqual({
        status: "REJECTED",
        failure_code: "REFERENCE_NOT_FOUND",
        reference_attempts: 8,
      });
    });

    test("serializes concurrent workers and commits pending effects atomically", async () => {
      const wallet = await createWallet("100.00");
      const referenceExternalTransactionId = "concurrent-late-bet";
      const response = await submit(
        "provider-a:concurrent-late-refund",
        requestBody(
          wallet,
          WagerTransactionKind.Refund,
          "20.00",
          referenceExternalTransactionId,
        ),
      );
      const body = await responseBody(response);
      const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
      bet.externalTransactionId = referenceExternalTransactionId;
      expect((await submit("provider-a:concurrent-late-bet", bet)).status).toBe(200);
      const [due] = await getTestDataSource().query(
        `SELECT reference_next_attempt_at FROM wager_transactions WHERE id = $1`,
        [body.transactionId],
      );
      const now = new Date(new Date(due.reference_next_attempt_at).getTime() + 1);
      const workerFactory = () =>
        new PendingReferenceWorker(
          getTestDataSource(),
          new ProcessWagerTransactionUseCase(getTestDataSource()),
          { info() {}, warn() {}, error() {} },
        );

      await getTestDataSource().query(`
        CREATE OR REPLACE FUNCTION fail_test_pending_reference_outbox()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'WagerTransactionProcessed'
            AND NEW.payload ->> 'kind' = 'REFUND' THEN
            RAISE EXCEPTION 'forced pending-reference outbox failure';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await getTestDataSource().query(`
        CREATE TRIGGER trg_test_fail_pending_reference_outbox
        BEFORE INSERT ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION fail_test_pending_reference_outbox();
      `);
      try {
        await Promise.all([workerFactory().runOnce(now), workerFactory().runOnce(now)]);
        const [stillPending] = await getTestDataSource().query(
          `SELECT status, reference_attempts
           FROM wager_transactions WHERE id = $1`,
          [body.transactionId],
        );
        expect(stillPending).toEqual({
          status: "PENDING_REFERENCE",
          reference_attempts: 0,
        });
        const [walletState] = await getTestDataSource().query(
          "SELECT balance FROM wallets WHERE id = $1",
          [wallet.id],
        );
        expect(walletState.balance).toBe("80.00");
        expect(
          await countByValue(
            "wallet_ledger_entries",
            "direction",
            "CREDIT",
            wallet.id,
          ),
        ).toBe(1);
      } finally {
        await getTestDataSource().query(
          "DROP TRIGGER IF EXISTS trg_test_fail_pending_reference_outbox ON outbox_messages",
        );
        await getTestDataSource().query(
          "DROP FUNCTION IF EXISTS fail_test_pending_reference_outbox()",
        );
      }

      const results = await Promise.all([
        workerFactory().runOnce(now),
        workerFactory().runOnce(now),
      ]);
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
      const [processed] = await getTestDataSource().query(
        "SELECT status FROM wager_transactions WHERE id = $1",
        [body.transactionId],
      );
      expect(processed.status).toBe("PROCESSED");
      expect(
        await countByValue(
          "wallet_ledger_entries",
          "direction",
          "CREDIT",
          wallet.id,
        ),
      ).toBe(2);
    });

  test("processes REFUND and ROLLBACK for each allowed reference kind", async () => {
    const refundWallet = await createWallet("100.00");
    const bet = requestBody(refundWallet, WagerTransactionKind.Bet, "25.00");
    expect((await submit("provider-a:refund-base-bet", bet)).status).toBe(200);
    const refund = requestBody(
      refundWallet,
      WagerTransactionKind.Refund,
      "25.00",
      bet.externalTransactionId,
    );
    const refundResponse = await submit("provider-a:valid-refund", refund);
    expect(refundResponse.status).toBe(200);
    expect(await responseBody(refundResponse)).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "100.00", currency: "BRL" },
    });

    const rollbackBet = requestBody(
      refundWallet,
      WagerTransactionKind.Rollback,
      "25.00",
      bet.externalTransactionId,
    );
    expect(
      await responseBody(
        await submit("provider-a:rollback-bet", rollbackBet),
      ),
    ).toMatchObject({ status: "PROCESSED", balance: { amount: "125.00" } });
    expect(
      await responseBody(
        await submit("provider-a:rollback-bet-again", {
          ...rollbackBet,
          externalTransactionId: "rollback-bet-again",
        }),
      ),
    ).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REVERSED",
    });

    const rollbackRefund = requestBody(
      refundWallet,
      WagerTransactionKind.Rollback,
      "25.00",
      refund.externalTransactionId,
    );
    expect(
      await responseBody(
        await submit("provider-a:rollback-refund", rollbackRefund),
      ),
    ).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    const [refundLedgerBalance] = await getTestDataSource().query(
      `SELECT COALESCE(sum(
         CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END
       ), 0)::text AS balance
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [refundWallet.id],
    );
    const [refundWalletBalance] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [refundWallet.id],
    );
    expect(refundLedgerBalance.balance).toBe(refundWalletBalance.balance);

    const winWallet = await createWallet("100.00");
    const win = requestBody(winWallet, WagerTransactionKind.Win, "10.00");
    expect((await submit("provider-a:rollback-base-win", win)).status).toBe(200);
    const rollbackWin = requestBody(
      winWallet,
      WagerTransactionKind.Rollback,
      "10.00",
      win.externalTransactionId,
    );
    expect(
      await responseBody(
        await submit("provider-a:rollback-win", rollbackWin),
      ),
    ).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    const [winLedgerBalance] = await getTestDataSource().query(
      `SELECT COALESCE(sum(
         CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END
       ), 0)::text AS balance
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [winWallet.id],
    );
    const [winWalletBalance] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [winWallet.id],
    );
    expect(winLedgerBalance.balance).toBe(winWalletBalance.balance);
  });

  test("rejects disallowed, incompatible, mismatched, and duplicate reversals", async () => {
    const wallet = await createWallet("100.00");
    const loss = requestBody(wallet, WagerTransactionKind.Loss, "10.00");
    expect((await submit("provider-a:reversal-base-loss", loss)).status).toBe(200);
    const refundLoss = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "10.00",
      loss.externalTransactionId,
    );
    expect(await submit("provider-a:refund-loss", refundLoss).then((r) => r.status)).toBe(422);
    expect(await responseBody(await submit("provider-a:refund-loss", refundLoss))).toMatchObject({
      failureCode: "REFERENCE_KIND_NOT_ALLOWED",
    });

    const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
    expect((await submit("provider-a:duplicate-reversal-base", bet)).status).toBe(200);
    const wrongAmount = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "19.00",
      bet.externalTransactionId,
    );
    const wrongAmountResult = await responseBody(
      await submit("provider-a:reversal-wrong-amount", wrongAmount),
    );
    expect(wrongAmountResult.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");

    const otherPlayerWallet = await createWallet("100.00");
    const incompatibleWallet = requestBody(
      otherPlayerWallet,
      WagerTransactionKind.Rollback,
      "20.00",
      bet.externalTransactionId,
    );
    const incompatibleResult = await responseBody(
      await submit("provider-a:reversal-other-wallet", incompatibleWallet),
    );
    expect(incompatibleResult.failureCode).toBe("REFERENCE_INCOMPATIBLE");

    const validRefund = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "20.00",
      bet.externalTransactionId,
    );
    const concurrentRefunds = await Promise.all([
      submit("provider-a:concurrent-refund-a", validRefund),
      submit("provider-a:concurrent-refund-b", {
        ...validRefund,
        externalTransactionId: "concurrent-refund-b",
      }),
    ]);
    expect(concurrentRefunds.map((response) => response.status).sort()).toEqual([
      200, 422,
    ]);
    const rejected = await responseBody(
      concurrentRefunds.find((response) => response.status === 422)!,
    );
    expect(rejected.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(
      await countByValue("wager_transactions", "kind", "REFUND", wallet.id),
    ).toBe(4);
    expect(
      await countByValue("wallet_ledger_entries", "direction", "CREDIT", wallet.id),
    ).toBe(2);
  });

  test("rejects a rollback that would make the wallet negative with a dedicated code", async () => {
    const wallet = await createWallet("100.00");
    const win = requestBody(wallet, WagerTransactionKind.Win, "100.00");
    expect((await submit("provider-a:negative-rollback-win", win)).status).toBe(200);
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "150.00");
    expect((await submit("provider-a:negative-rollback-bet", bet)).status).toBe(200);
    const rollback = requestBody(
      wallet,
      WagerTransactionKind.Rollback,
      "100.00",
      win.externalTransactionId,
    );
    const response = await submit("provider-a:negative-rollback", rollback);
    expect(response.status).toBe(422);
    const result = await responseBody(response);
    expect(result).toMatchObject({
      failureCode: "REVERSAL_WOULD_NEGATIVE_BALANCE",
      balance: { amount: "50.00", currency: "BRL" },
    });
    const [reversalLedger] = await getTestDataSource().query(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = $1",
      [result.transactionId],
    );
    expect(reversalLedger.count).toBe(0);
  });

  test("replays successful reversals and conflicts on a changed reference payload", async () => {
    const wallet = await createWallet("100.00");
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "10.00");
    expect((await submit("provider-a:replay-reference-bet", bet)).status).toBe(200);
    const refund = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "10.00",
      bet.externalTransactionId,
    );
    const key = "provider-a:refund-replay";
    const first = await submit(key, refund);
    const firstBody = await responseBody(first);
    expect(first.status).toBe(200);
    expect(await responseBody(await submit(key, refund))).toMatchObject({
      ...firstBody,
      idempotentReplay: true,
    });
    const conflict = await submit(key, {
      ...refund,
      referenceExternalTransactionId: "different-reference",
    });
    expect(conflict.status).toBe(409);
    expect(
      await countByValue("wager_transactions", "kind", "REFUND", wallet.id),
    ).toBe(1);
  });

  test("rolls back a reversal completely when Outbox insertion fails", async () => {
    const wallet = await createWallet("100.00");
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
    expect((await submit("provider-a:atomic-reversal-base", bet)).status).toBe(200);
    await getTestDataSource().query(`
      CREATE OR REPLACE FUNCTION fail_test_reversal_outbox_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'WagerTransactionProcessed'
          AND NEW.payload ->> 'kind' = 'REFUND' THEN
          RAISE EXCEPTION 'forced reversal outbox insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await getTestDataSource().query(`
      CREATE TRIGGER trg_test_fail_reversal_outbox_insert
      BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION fail_test_reversal_outbox_insert();
    `);
    const refund = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "20.00",
      bet.externalTransactionId,
    );
    try {
      expect(
        (await submit("provider-a:atomic-reversal", refund)).status,
      ).toBe(500);
      const [walletState] = await getTestDataSource().query(
        "SELECT balance FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(walletState.balance).toBe("80.00");
      expect(
        await countByValue("wager_transactions", "kind", "REFUND", wallet.id),
      ).toBe(0);
      expect(
        await countByValue("wallet_ledger_entries", "direction", "CREDIT", wallet.id),
      ).toBe(1);
    } finally {
      await getTestDataSource().query(
        "DROP TRIGGER IF EXISTS trg_test_fail_reversal_outbox_insert ON outbox_messages",
      );
      await getTestDataSource().query(
        "DROP FUNCTION IF EXISTS fail_test_reversal_outbox_insert()",
      );
    }
  });

  test("rolls back a reversal completely when ledger insertion fails", async () => {
    const wallet = await createWallet("100.00");
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
    expect((await submit("provider-a:ledger-reversal-base", bet)).status).toBe(200);
    await getTestDataSource().query(`
      CREATE OR REPLACE FUNCTION fail_test_reversal_ledger_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.direction = 'CREDIT' AND NEW.amount = 20.00 THEN
          RAISE EXCEPTION 'forced reversal ledger insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await getTestDataSource().query(`
      CREATE TRIGGER trg_test_fail_reversal_ledger_insert
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fail_test_reversal_ledger_insert();
    `);
    const refund = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "20.00",
      bet.externalTransactionId,
    );
    try {
      expect(
        (await submit("provider-a:ledger-reversal-failure", refund)).status,
      ).toBe(500);
      const [walletState] = await getTestDataSource().query(
        "SELECT balance FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(walletState.balance).toBe("80.00");
      expect(
        await countByValue("wager_transactions", "kind", "REFUND", wallet.id),
      ).toBe(0);
      expect(
        await countByValue("wallet_ledger_entries", "direction", "CREDIT", wallet.id),
      ).toBe(1);
    } finally {
      await getTestDataSource().query(
        "DROP TRIGGER IF EXISTS trg_test_fail_reversal_ledger_insert ON wallet_ledger_entries",
      );
      await getTestDataSource().query(
        "DROP FUNCTION IF EXISTS fail_test_reversal_ledger_insert()",
      );
    }
  });

  test("preserves malformed request handling for reversal contracts", async () => {
    const wallet = await createWallet("100.00");
    const body = requestBody(wallet, WagerTransactionKind.Bet, "10.00");
    const invalidMoney = await submit("provider-a:invalid-money", {
      ...body,
      kind: "REFUND",
      referenceExternalTransactionId: "provider-a:original-bet",
      money: { amount: "1e2", currency: "BRL" },
    });
    expect(invalidMoney.status).toBe(400);
    const missingRollbackReference = await submit(
      "provider-a:missing-rollback-reference",
      { ...body, kind: "ROLLBACK" },
    );
    expect(missingRollbackReference.status).toBe(400);
  });

  test("keeps a provider-mismatched external reference pending under tuple lookup", async () => {
    const wallet = await createWallet("100.00");
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "10.00");
    expect((await submit("provider-a:provider-ref-bet", bet)).status).toBe(200);
    const refund = {
      ...requestBody(wallet, WagerTransactionKind.Refund, "10.00", bet.externalTransactionId),
      providerId: "different-provider",
    };
    const response = await submit("provider-b:provider-ref-refund", refund);
    expect(response.status).toBe(202);
    expect(await responseBody(response)).toMatchObject({
      status: "PENDING_REFERENCE",
    });
  });

  test("does not alter the wallet on invalid reversal compatibility", async () => {
    const wallet = await createWallet("100.00");
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
    expect((await submit("provider-a:round-ref-bet", bet)).status).toBe(200);
    const differentRound = {
      ...requestBody(
        wallet,
        WagerTransactionKind.Refund,
        "20.00",
        bet.externalTransactionId,
      ),
      roundId: "different-round",
    };
    const response = await submit("provider-a:round-ref-refund", differentRound);
    expect(response.status).toBe(422);
    expect(await responseBody(response)).toMatchObject({
      failureCode: "REFERENCE_INCOMPATIBLE",
    });
    const [balance] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(balance.balance).toBe("80.00");
  });

  test("rejects player and currency mismatches against a resolved reference", async () => {
    const wallet = await createWallet("100.00");
    const bet = requestBody(wallet, WagerTransactionKind.Bet, "20.00");
    expect((await submit("provider-a:tampered-reference-base", bet)).status).toBe(200);

    await getTestDataSource().query(
      `UPDATE wager_transactions
       SET currency = 'USD'
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [bet.providerId, bet.externalTransactionId],
    );
    const refund = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "20.00",
      bet.externalTransactionId,
    );
    expect(
      await responseBody(
        await submit("provider-a:reference-currency-mismatch", refund),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_INCOMPATIBLE" });

    await getTestDataSource().query(
      `UPDATE wager_transactions
       SET currency = 'BRL', player_id = $1
       WHERE provider_id = $2 AND external_transaction_id = $3`,
      [randomUUID(), bet.providerId, bet.externalTransactionId],
    );
    expect(
      await responseBody(
        await submit("provider-a:reference-player-mismatch", {
          ...refund,
          externalTransactionId: "reference-player-mismatch-refund",
        }),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_INCOMPATIBLE" });

    const [walletBalance] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(walletBalance.balance).toBe("80.00");
  });

  test("rejects refund of WIN and rollback of LOSS", async () => {
    const wallet = await createWallet("100.00");
    const win = requestBody(wallet, WagerTransactionKind.Win, "10.00");
    expect((await submit("provider-a:refund-win-base", win)).status).toBe(200);
    const refundWin = requestBody(
      wallet,
      WagerTransactionKind.Refund,
      "10.00",
      win.externalTransactionId,
    );
    expect(
      await responseBody(await submit("provider-a:refund-win", refundWin)),
    ).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_KIND_NOT_ALLOWED" });

    const loss = requestBody(wallet, WagerTransactionKind.Loss, "10.00");
    expect((await submit("provider-a:rollback-loss-base", loss)).status).toBe(200);
    const rollbackLoss = requestBody(
      wallet,
      WagerTransactionKind.Rollback,
      "10.00",
      loss.externalTransactionId,
    );
    expect(
      await responseBody(await submit("provider-a:rollback-loss", rollbackLoss)),
    ).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_KIND_NOT_ALLOWED" });
  });

  test("records provider external transaction identity uniquely", async () => {
    const wallet = await createWallet("100.00");
    const first = requestBody(wallet, WagerTransactionKind.Bet, "10.00");
    expect((await submit("provider-a:external-identity-a", first)).status).toBe(200);
    const reusedExternalId = {
      ...requestBody(wallet, WagerTransactionKind.Win, "10.00"),
      externalTransactionId: first.externalTransactionId,
    };
    expect(
      (await submit("provider-a:external-identity-b", reusedExternalId)).status,
    ).toBe(409);
  });

  test("serializes two concurrent bets against the same wallet balance", async () => {
    const wallet = await createWallet("100.00");
    const requests = await Promise.all([
      submit(
        "provider-a:race-bet-1",
        requestBody(wallet, WagerTransactionKind.Bet, "80.00"),
      ),
      submit(
        "provider-a:race-bet-2",
        requestBody(wallet, WagerTransactionKind.Bet, "80.00"),
      ),
    ]);
    const statuses = requests.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 422]);

    const [persistedWallet] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(persistedWallet.balance).toBe("20.00");
    expect(
      await countByValue("wallet_ledger_entries", "direction", "DEBIT", wallet.id),
    ).toBe(1);
    expect(
      await countByValue("wager_transactions", "kind", "BET", wallet.id),
    ).toBe(2);
  });

  test("handles a concurrent idempotency-key conflict across different wallet locks", async () => {
    const firstWallet = await createWallet("100.00");
    const secondWallet = await createWallet("100.00");
    const key = "provider-a:cross-wallet-key";
    const [first, second] = await Promise.all([
      submit(
        key,
        requestBody(firstWallet, WagerTransactionKind.Win, "10.00"),
      ),
      submit(
        key,
        requestBody(secondWallet, WagerTransactionKind.Win, "10.00"),
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const [winnerWallet, loserWallet] =
      first.status === 200
        ? [firstWallet, secondWallet]
        : [secondWallet, firstWallet];
    const [winner] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [winnerWallet.id],
    );
    const [loser] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [loserWallet.id],
    );
    expect(winner.balance).toBe("110.00");
    expect(loser.balance).toBe("100.00");
    expect(
      (await getTestDataSource().query(
        "SELECT count(*)::int AS count FROM wager_transactions WHERE idempotency_key = $1",
        [key],
      ))[0].count,
    ).toBe(1);
  });

  test("processes fifty concurrent requests with the same key exactly once", async () => {
    const wallet = await createWallet("1000.00");
    const key = "provider-a:fifty-way-replay";
    const body = requestBody(wallet, WagerTransactionKind.Bet, "80.00");
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(key, body)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(responseBody));
    expect(bodies.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(bodies.filter((result) => result.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(bodies.map((result) => result.transactionId)).size).toBe(1);
    expect(await countRows("wager_transactions", wallet.id)).toBe(2);
    expect(
      await countByValue("wallet_ledger_entries", "direction", "DEBIT", wallet.id),
    ).toBe(1);
    const persistedEvents = await outboxEventsForTransaction(
      transactionIdFrom(bodies[0]),
    );
    expect(persistedEvents).toHaveLength(2);
    expect(persistedEvents.map(({ eventType }) => eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    const [persistedWallet] = await getTestDataSource().query(
      "SELECT balance FROM wallets WHERE id = $1",
      [wallet.id],
    );
    expect(persistedWallet.balance).toBe("920.00");
  });

  test("serializes same-wallet bets across three independent application instances", async () => {
    const wallet = await createWallet("100.00");
    const instances = await Promise.all(
      Array.from({ length: 3 }, () =>
        startIndependentWagerApp(testDatabaseName as string),
      ),
    );

    try {
      const responses = await Promise.all(
        instances.map((instance, index) =>
          submitTo(
            instance.baseUrl,
            `provider-a:multi-instance-bet-${index}`,
            requestBody(wallet, WagerTransactionKind.Bet, "80.00"),
          ),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 422, 422,
      ]);

      const [persistedWallet] = await getTestDataSource().query(
        "SELECT balance FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(persistedWallet.balance).toBe("20.00");
      expect(
        await countByValue(
          "wallet_ledger_entries",
          "direction",
          "DEBIT",
          wallet.id,
        ),
      ).toBe(1);
      expect(
        await countByValue(
          "wager_transactions",
          "kind",
          WagerTransactionKind.Bet,
          wallet.id,
        ),
      ).toBe(3);
      const [transactionCounts] = await getTestDataSource().query(
        `SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
                count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
         FROM wager_transactions
         WHERE wallet_id = $1 AND kind = 'BET'`,
        [wallet.id],
      );
      expect(transactionCounts).toEqual({ processed: 1, rejected: 2 });
    } finally {
      await Promise.all(instances.map((instance) => instance.app.close()));
    }
  });

  test("rolls back the idempotency record and wallet change on unexpected ledger failure", async () => {
    const wallet = await createWallet("100.00");
    await getTestDataSource().query(`
      CREATE OR REPLACE FUNCTION fail_test_wager_ledger_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.amount = 42.42 THEN
          RAISE EXCEPTION 'forced wager ledger insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await getTestDataSource().query(`
      CREATE TRIGGER trg_test_fail_wager_ledger_insert
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fail_test_wager_ledger_insert();
    `);

    try {
      const response = await submit(
        "provider-a:forced-ledger-failure",
        requestBody(wallet, WagerTransactionKind.Bet, "42.42"),
      );
      expect(response.status).toBe(500);
      expect(await countByValue("wager_transactions", "kind", "BET", wallet.id)).toBe(0);
      expect(await countByValue("wallet_ledger_entries", "direction", "DEBIT", wallet.id)).toBe(0);

      const [persistedWallet] = await getTestDataSource().query(
        "SELECT balance, version FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(persistedWallet).toMatchObject({ balance: "100.00", version: 1 });
    } finally {
      await getTestDataSource().query(
        "DROP TRIGGER IF EXISTS trg_test_fail_wager_ledger_insert ON wallet_ledger_entries",
      );
      await getTestDataSource().query(
        "DROP FUNCTION IF EXISTS fail_test_wager_ledger_insert()",
      );
    }
  });

  test("rolls back processed and rejected transactions when Outbox insertion fails", async () => {
    const wallet = await createWallet("100.00");
    await getTestDataSource().query(`
      CREATE OR REPLACE FUNCTION fail_test_outbox_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type IN ('WalletBalanceChanged', 'WagerTransactionRejected') THEN
          RAISE EXCEPTION 'forced outbox insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await getTestDataSource().query(`
      CREATE TRIGGER trg_test_fail_outbox_insert
      BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION fail_test_outbox_insert();
    `);

    const processedKey = "provider-a:outbox-processed-failure";
    const rejectedKey = "provider-a:outbox-rejected-failure";

    try {
      const processedFailure = await submit(
        processedKey,
        requestBody(wallet, WagerTransactionKind.Bet, "42.42"),
      );
      expect(processedFailure.status).toBe(500);

      const rejectionFailure = await submit(
        rejectedKey,
        requestBody(wallet, WagerTransactionKind.Bet, "101.00"),
      );
      expect(rejectionFailure.status).toBe(500);

      const [transactions] = await getTestDataSource().query(
        `SELECT count(*)::int AS count
         FROM wager_transactions
         WHERE idempotency_key IN ($1, $2)`,
        [processedKey, rejectedKey],
      );
      expect(transactions.count).toBe(0);

      const [walletState] = await getTestDataSource().query(
        "SELECT balance, version FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(walletState).toEqual({ balance: "100.00", version: 1 });

      expect(await countRows("wallet_ledger_entries", wallet.id)).toBe(1);
      const [outboxRows] = await getTestDataSource().query(
        `SELECT count(*)::int AS count
         FROM outbox_messages
         WHERE payload ->> 'walletId' = $1`,
        [wallet.id],
      );
      expect(outboxRows.count).toBe(0);
    } finally {
      await getTestDataSource().query(
        "DROP TRIGGER IF EXISTS trg_test_fail_outbox_insert ON outbox_messages",
      );
      await getTestDataSource().query(
        "DROP FUNCTION IF EXISTS fail_test_outbox_insert()",
      );
    }
  });
});
