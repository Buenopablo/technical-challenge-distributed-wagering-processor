import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  InsufficientWalletBalanceError,
  Wallet,
  WalletInvariantError,
} from "../../src/domain/wallet/wallet";
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../src/domain/money/money";
import {
  InvalidWagerTransactionStateError,
  WagerTransaction,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction/wager-transaction";

const playerId = "00000000-0000-4000-8000-000000000001";
const at = new Date("2026-10-24T12:00:00.000Z");

describe("Wallet domain", () => {
  test("opens at version one with the initial balance and currency", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: "15.25", currency: "BRL" }),
      at,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "15.25", currency: "BRL" });
    expect(wallet.currency).toBe("BRL");
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(at);
  });

  test("increments version only when a balance operation changes the balance", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      at,
    });

    const zeroCredit = wallet.credit(Money.zero("BRL"), at);
    expect(zeroCredit.changed).toBe(false);
    expect(wallet.version).toBe(1);

    const credit = wallet.credit(
      Money.from({ amount: "0.25", currency: "BRL" }),
      at,
    );
    expect(credit.changed).toBe(true);
    expect(wallet.balance.toString()).toBe("10.25");
    expect(wallet.version).toBe(2);

    wallet.debit(Money.from({ amount: "0.25", currency: "BRL" }), at);
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(3);
  });

  test("rejects negative balance, negative amounts, and a currency mismatch", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: "1.00", currency: "BRL" }),
      at,
    });

    expect(() =>
      Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance: Money.from({ amount: "0.00", currency: "BRL" }).subtract(
          Money.from({ amount: "0.01", currency: "BRL" }),
        ),
        at,
      }),
    ).toThrow(WalletInvariantError);

    expect(() =>
      wallet.credit(
        Money.from({ amount: "1.00", currency: "USD" }),
        at,
      ),
    ).toThrow(WalletInvariantError);

    expect(() =>
      wallet.debit(Money.from({ amount: "1.01", currency: "BRL" }), at),
    ).toThrow(InsufficientWalletBalanceError);
    expect(wallet.balance.toString()).toBe("1.00");
    expect(wallet.version).toBe(1);
  });
});

describe("OPENING transaction domain", () => {
  test("transitions from pending to processed once", () => {
    const transaction = WagerTransaction.createOpening({
      id: randomUUID(),
      walletId: randomUUID(),
      playerId,
      money: Money.from({ amount: "5.00", currency: "BRL" }),
      idempotencyKey: `OPENING:${randomUUID()}`,
      payloadHash: "a".repeat(64),
      createdAt: at,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    transaction.markProcessed(at);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(at);
    expect(() => transaction.markProcessed(at)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  test("does not create an opening transaction for a zero or negative amount", () => {
    const common = {
      id: randomUUID(),
      walletId: randomUUID(),
      playerId,
      idempotencyKey: "opening",
      payloadHash: "a".repeat(64),
      createdAt: at,
    };

    expect(() =>
      WagerTransaction.createOpening({
        ...common,
        money: Money.zero("BRL"),
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });
});

describe("WalletLedgerEntry", () => {
  test("validates opening arithmetic and is immutable", () => {
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: randomUUID(),
      transactionId: randomUUID(),
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "12.34", currency: "BRL" }),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: Money.from({ amount: "12.34", currency: "BRL" }),
      createdAt: at,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);

    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(2000);
    expect(entry.createdAt).toEqual(at);
  });

  test("rejects a ledger entry whose before/after balances do not reconcile", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: randomUUID(),
        transactionId: randomUUID(),
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "12.34", currency: "BRL" }),
        balanceBefore: Money.zero("BRL"),
        balanceAfter: Money.from({ amount: "12.35", currency: "BRL" }),
        createdAt: at,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
