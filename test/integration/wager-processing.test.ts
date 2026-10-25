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
  kind: WagerTransactionKind.Bet | WagerTransactionKind.Win | WagerTransactionKind.Loss,
  amount: string,
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

  test("distinguishes malformed requests from valid operations not implemented in this stage", async () => {
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
      referenceExternalTransactionId: "provider-a:original-bet",
    });
    expect(refund.status).toBe(501);
    const rollback = await submit("provider-a:deferred-rollback", {
      ...body,
      kind: "ROLLBACK",
      referenceExternalTransactionId: "provider-a:original-win",
    });
    expect(rollback.status).toBe(501);
    const malformedRefund = await submit("provider-a:malformed-refund", {
      ...body,
      kind: "REFUND",
      referenceExternalTransactionId: "provider-a:original-bet",
      money: { amount: "1e2", currency: "BRL" },
    });
    expect(malformedRefund.status).toBe(400);
    const missingRollbackReference = await submit(
      "provider-a:missing-rollback-reference",
      { ...body, kind: "ROLLBACK" },
    );
    expect(missingRollbackReference.status).toBe(400);
    expect(await countByValue("wager_transactions", "kind", "BET", wallet.id)).toBe(0);
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
