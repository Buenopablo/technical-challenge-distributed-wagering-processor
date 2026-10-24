import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  InvalidWagerTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction/wager-transaction";

const at = new Date("2026-10-24T12:00:00.000Z");

function createTransaction(
  kind: WagerTransactionKind.Bet | WagerTransactionKind.Win | WagerTransactionKind.Loss,
  amount = "80.00",
): WagerTransaction {
  return WagerTransaction.createExternal({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: "a".repeat(64),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: Money.from({ amount, currency: "BRL" }),
    createdAt: at,
  });
}

describe("external wager transactions", () => {
  test("creates BET, WIN, and LOSS as pending", () => {
    const kinds: Array<
      WagerTransactionKind.Bet | WagerTransactionKind.Win | WagerTransactionKind.Loss
    > = [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
    ];
    for (const kind of kinds) {
      const transaction = createTransaction(kind);

      expect(transaction.kind).toBe(kind);
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    }
  });

  test("allows zero amounts because the challenge does not define them as invalid", () => {
    const transaction = createTransaction(WagerTransactionKind.Bet, "0.00");

    transaction.markProcessed(at);

    expect(transaction.money.isZero()).toBe(true);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test("rejects OPENING through the external transaction factory", () => {
    expect(() =>
      WagerTransaction.createExternal({
        id: randomUUID(),
        providerId: "provider-a",
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: "a".repeat(64),
        walletId: randomUUID(),
        playerId: randomUUID(),
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Opening,
        money: Money.from({ amount: "1.00", currency: "BRL" }),
        createdAt: at,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("persists business rejection as a terminal state with a failure code", () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);
    transaction.reject("INSUFFICIENT_FUNDS");

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(() => transaction.markProcessed(at)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });
});
