import { describe, expect, test } from "bun:test";
import {
  PENDING_REFERENCE_BASE_DELAY_MS,
  PENDING_REFERENCE_MAX_ATTEMPTS,
  PENDING_REFERENCE_MAX_DELAY_MS,
  PENDING_REFERENCE_TTL_MS,
  pendingReferenceRetryDelayMs,
} from "../../src/application/wagering/pending-reference-policy";

describe("pending-reference retry policy", () => {
  test("uses capped exponential backoff and a finite attempt/age limit", () => {
    expect(pendingReferenceRetryDelayMs(1)).toBe(5_000);
    expect(pendingReferenceRetryDelayMs(2)).toBe(10_000);
    expect(pendingReferenceRetryDelayMs(8)).toBe(640_000);
    expect(pendingReferenceRetryDelayMs(20)).toBe(
      PENDING_REFERENCE_MAX_DELAY_MS,
    );
    expect(PENDING_REFERENCE_MAX_ATTEMPTS).toBe(8);
    expect(PENDING_REFERENCE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(PENDING_REFERENCE_BASE_DELAY_MS).toBe(5_000);
    expect(() => pendingReferenceRetryDelayMs(0)).toThrow(RangeError);
  });
});
