import { describe, expect, test } from "bun:test";
import {
  canonicalizePayload,
  hashWagerPayload,
  ProcessWagerTransactionInput,
} from "../../src/application/wagering/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../src/domain/wager-transaction/wager-transaction";

const input: ProcessWagerTransactionInput = {
  idempotencyKey: "provider-a:external-1",
  providerId: "provider-a",
  externalTransactionId: "external-1",
  playerId: "00000000-0000-4000-8000-000000000001",
  walletId: "00000000-0000-4000-8000-000000000002",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: { amount: "25.00", currency: "BRL" },
};

describe("wager payload canonicalization", () => {
  test("is stable regardless of property order and excludes the idempotency key", () => {
    const reordered: ProcessWagerTransactionInput = {
      money: input.money,
      kind: input.kind,
      gameId: input.gameId,
      roundId: input.roundId,
      walletId: input.walletId,
      playerId: input.playerId,
      externalTransactionId: input.externalTransactionId,
      providerId: input.providerId,
      idempotencyKey: "a-different-key",
    };

    expect(canonicalizePayload(input)).toBe(canonicalizePayload(reordered));
    expect(hashWagerPayload(input)).toBe(hashWagerPayload(reordered));
  });

  test("changes when a business field changes", () => {
    expect(
      hashWagerPayload({
        ...input,
        money: { amount: "25.01", currency: "BRL" },
      }),
    ).not.toBe(hashWagerPayload(input));
  });
});
