export const PENDING_REFERENCE_MAX_ATTEMPTS = 8;
export const PENDING_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_REFERENCE_BASE_DELAY_MS = 5_000;
export const PENDING_REFERENCE_MAX_DELAY_MS = 60 * 60 * 1000;
export const PENDING_REFERENCE_POLL_INTERVAL_MS = 1_000;
export const PENDING_REFERENCE_BATCH_SIZE = 50;

export function pendingReferenceRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("Pending reference attempt must be a positive integer");
  }
  return Math.min(
    PENDING_REFERENCE_BASE_DELAY_MS * 2 ** (attempt - 1),
    PENDING_REFERENCE_MAX_DELAY_MS,
  );
}
