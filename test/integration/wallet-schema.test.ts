import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { OpenWalletUseCase } from "../../src/application/wallets/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { createDatabaseOptions } from "../../src/database/data-source";
import { WagerTransactionKind } from "../../src/domain/wager-transaction/wager-transaction";

let testDataSource: DataSource | undefined;
let adminDataSource: DataSource | undefined;
let testDatabaseName: string | undefined;

function getTestDataSource(): DataSource {
  if (!testDataSource) {
    throw new Error("The PostgreSQL integration-test database is not ready");
  }

  return testDataSource;
}

function createOpenWalletUseCase(): OpenWalletUseCase {
  return new OpenWalletUseCase(getTestDataSource());
}

describe("wallet opening persistence in PostgreSQL", () => {
  beforeAll(async () => {
    const options = createDatabaseOptions();
    if (options.type !== "postgres") {
      throw new Error("Integration tests require the PostgreSQL DataSource");
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
  });

  afterAll(async () => {
    if (testDataSource?.isInitialized) {
      await testDataSource.destroy();
    }
    if (adminDataSource?.isInitialized && testDatabaseName) {
      await adminDataSource.query(`DROP DATABASE "${testDatabaseName}"`);
      await adminDataSource.destroy();
    }
  });

  test("persists wallet, processed OPENING, and balanced credit atomically", async () => {
    const openWallet = createOpenWalletUseCase();
    const playerId = randomUUID();
    const result = await openWallet.execute({
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    expect(result.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(result.version).toBe(1);

    const wallets = await getTestDataSource().query(
      "SELECT id, player_id, currency, balance, version FROM wallets WHERE id = $1",
      [result.id],
    );
    const transactions = await getTestDataSource().query(
      `SELECT kind, status, provider_id, external_transaction_id,
              round_id, game_id, amount, currency, idempotency_key,
              payload_hash, processed_at
       FROM wager_transactions WHERE wallet_id = $1`,
      [result.id],
    );
    const entries = await getTestDataSource().query(
      `SELECT direction, amount, currency, balance_before, balance_after
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [result.id],
    );

    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({
      player_id: playerId,
      currency: "BRL",
      balance: "1000.00",
      version: 1,
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      kind: "OPENING",
      status: "PROCESSED",
      provider_id: null,
      external_transaction_id: null,
      round_id: null,
      game_id: null,
      amount: "1000.00",
      currency: "BRL",
      idempotency_key: `OPENING:${result.id}`,
    });
    expect(transactions[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(transactions[0].processed_at).toBeInstanceOf(Date);
    expect(entries).toEqual([
      {
        direction: "CREDIT",
        amount: "1000.00",
        currency: "BRL",
        balance_before: "0.00",
        balance_after: "1000.00",
      },
    ]);
  });

  test("creates no OPENING or ledger row for zero and rejects negative input", async () => {
    const openWallet = createOpenWalletUseCase();
    const playerId = randomUUID();
    const result = await openWallet.execute({
      playerId,
      initialBalance: { amount: "0.00", currency: "BRL" },
    });

    expect(result.balance).toEqual({ amount: "0.00", currency: "BRL" });
    expect(result.version).toBe(1);

    const openingCount = await getTestDataSource().query(
      "SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = $1",
      [result.id],
    );
    const ledgerCount = await getTestDataSource().query(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1",
      [result.id],
    );

    expect(openingCount[0].count).toBe(0);
    expect(ledgerCount[0].count).toBe(0);
    await expect(
      openWallet.execute({
        playerId: randomUUID(),
        initialBalance: { amount: "-0.01", currency: "BRL" },
      }),
    ).rejects.toThrow();
  });

  test("rejects duplicate player/currency wallets without partial records", async () => {
    const openWallet = createOpenWalletUseCase();
    const playerId = randomUUID();
    const first = await openWallet.execute({
      playerId,
      initialBalance: { amount: "0.00", currency: "BRL" },
    });

    await expect(
      openWallet.execute({
        playerId,
        initialBalance: { amount: "1.00", currency: "BRL" },
      }),
    ).rejects.toThrow();

    const wallets = await getTestDataSource().query(
      "SELECT id FROM wallets WHERE player_id = $1 AND currency = 'BRL'",
      [playerId],
    );
    const transactions = await getTestDataSource().query(
      "SELECT id FROM wager_transactions WHERE player_id = $1",
      [playerId],
    );

    expect(wallets).toEqual([{ id: first.id }]);
    expect(transactions).toHaveLength(0);
  });

  test("rolls back wallet and OPENING when the ledger insert fails", async () => {
    const openWallet = createOpenWalletUseCase();
    const playerId = randomUUID();
    await getTestDataSource().query(`
      CREATE OR REPLACE FUNCTION fail_test_opening_ledger_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.amount = 42.42 THEN
          RAISE EXCEPTION 'forced ledger insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await getTestDataSource().query(`
      CREATE TRIGGER trg_test_fail_opening_ledger_insert
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fail_test_opening_ledger_insert();
    `);

    try {
      await expect(
        openWallet.execute({
          playerId,
          initialBalance: { amount: "42.42", currency: "BRL" },
        }),
      ).rejects.toThrow();

      const wallets = await getTestDataSource().query(
        "SELECT id FROM wallets WHERE player_id = $1",
        [playerId],
      );
      const transactions = await getTestDataSource().query(
        "SELECT id FROM wager_transactions WHERE player_id = $1",
        [playerId],
      );

      expect(wallets).toHaveLength(0);
      expect(transactions).toHaveLength(0);
    } finally {
      await getTestDataSource().query(
        "DROP TRIGGER IF EXISTS trg_test_fail_opening_ledger_insert ON wallet_ledger_entries",
      );
      await getTestDataSource().query(
        "DROP FUNCTION IF EXISTS fail_test_opening_ledger_insert()",
      );
    }
  });

  test("rejects updating or deleting an existing ledger entry", async () => {
    const openWallet = createOpenWalletUseCase();
    const result = await openWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "5.00", currency: "BRL" },
    });

    const [entry] = await getTestDataSource().query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [result.id],
    );

    await expect(
      getTestDataSource().query(
        "UPDATE wallet_ledger_entries SET amount = '6.00' WHERE id = $1",
        [entry.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      getTestDataSource().query(
        "DELETE FROM wallet_ledger_entries WHERE id = $1",
        [entry.id],
      ),
    ).rejects.toThrow(/append-only/);

    const [remaining] = await getTestDataSource().query(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE id = $1",
      [entry.id],
    );
    expect(remaining.count).toBe(1);
  });

  test("reverts and reapplies the wager idempotency and OPENING/ledger migrations", async () => {
    await getTestDataSource().undoLastMigration();

    const resultColumnAfterDown = await getTestDataSource().query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'wager_transactions'
        AND column_name IN ('result_balance', 'result_currency')
    `);
    const openingIndexAfterDown = await getTestDataSource().query(`
      SELECT indexdef
      FROM pg_indexes
      WHERE tablename = 'wager_transactions'
        AND indexname = 'uq_wager_transactions_opening_key'
    `);
    expect(resultColumnAfterDown).toHaveLength(0);
    expect(openingIndexAfterDown).toHaveLength(1);

    await getTestDataSource().runMigrations();
    const resultColumnAfterUp = await getTestDataSource().query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'wager_transactions'
        AND column_name IN ('result_balance', 'result_currency')
    `);
    const idempotencyIndexAfterUp = await getTestDataSource().query(`
      SELECT indexdef
      FROM pg_indexes
      WHERE tablename = 'wager_transactions'
        AND indexname = 'uq_wager_transactions_idempotency_key'
    `);
    expect(resultColumnAfterUp).toHaveLength(2);
    expect(idempotencyIndexAfterUp[0].indexdef).toContain("UNIQUE");

    await getTestDataSource().undoLastMigration();
    await getTestDataSource().undoLastMigration();
    const tablesAfterDown = await getTestDataSource().query(`
      SELECT to_regclass('public.wallets') AS wallets,
             to_regclass('public.wager_transactions') AS transactions,
             to_regclass('public.wallet_ledger_entries') AS ledger
    `);
    expect(tablesAfterDown[0]).toEqual({
      wallets: "wallets",
      transactions: null,
      ledger: null,
    });

    await getTestDataSource().runMigrations();
    const tablesAfterUp = await getTestDataSource().query(`
      SELECT to_regclass('public.wallets') AS wallets,
             to_regclass('public.wager_transactions') AS transactions,
             to_regclass('public.wallet_ledger_entries') AS ledger
    `);
    expect(tablesAfterUp[0]).toEqual({
      wallets: "wallets",
      transactions: "wager_transactions",
      ledger: "wallet_ledger_entries",
    });
  });

  test("refuses to revert idempotency snapshots needed by terminal transactions", async () => {
    const wallet = await createOpenWalletUseCase().execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const idempotencyKey = `migration-snapshot:${randomUUID()}`;
    await new ProcessWagerTransactionUseCase(getTestDataSource()).execute({
      idempotencyKey,
      providerId: "migration-test",
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "migration-test-round",
      gameId: "migration-test-game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "10.00", currency: "BRL" },
    });

    await expect(getTestDataSource().undoLastMigration()).rejects.toThrow(
      /external terminal transactions exist and require their result snapshots/,
    );

    const [snapshot] = await getTestDataSource().query(
      `SELECT result_balance, result_currency
       FROM wager_transactions
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    expect(snapshot).toEqual({
      result_balance: "90.00",
      result_currency: "BRL",
    });
    expect(await getTestDataSource().runMigrations()).toEqual([]);
  });
});
