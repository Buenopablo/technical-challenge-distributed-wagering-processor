import { DataSource } from "typeorm";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction";
import { ProcessWagerTransactionUseCase } from "./process-wager-transaction.use-case";
import {
  PENDING_REFERENCE_BATCH_SIZE,
  PENDING_REFERENCE_MAX_ATTEMPTS,
  PENDING_REFERENCE_POLL_INTERVAL_MS,
  PENDING_REFERENCE_TTL_MS,
  pendingReferenceRetryDelayMs,
} from "./pending-reference-policy";

interface PendingReferenceCandidate {
  id: string;
}

export interface PendingReferenceWorkerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: PendingReferenceWorkerLogger = {
  info: (message, context) => console.info(message, context ?? {}),
  warn: (message, context) => console.warn(message, context ?? {}),
  error: (message, context) => console.error(message, context ?? {}),
};

function waitForNextCycle(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class PendingReferenceWorker {
  constructor(
    private readonly dataSource: DataSource,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly logger = defaultLogger,
    private readonly batchSize = PENDING_REFERENCE_BATCH_SIZE,
    private readonly pollIntervalMs = PENDING_REFERENCE_POLL_INTERVAL_MS,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error("Pending-reference batch size must be between 1 and 100");
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error("Pending-reference poll interval must be positive");
    }
  }

  async runOnce(now?: Date): Promise<number> {
    const scheduledAt = now ?? new Date();
    const candidates = (await this.dataSource.query(
      `SELECT id
       FROM wager_transactions
       WHERE status = $1 AND reference_next_attempt_at <= $2
       ORDER BY reference_next_attempt_at, created_at, id
       LIMIT $3`,
      [
        WagerTransactionStatus.PendingReference,
        scheduledAt,
        this.batchSize,
      ],
    )) as PendingReferenceCandidate[];

    let finalized = 0;
    for (const candidate of candidates) {
      try {
        const attemptedAt = now ?? new Date();
        const result = await this.dataSource.transaction((manager) =>
          this.useCase.processPendingReferenceInTransaction(
            manager,
            candidate.id,
            attemptedAt,
            {
              maxAttempts: PENDING_REFERENCE_MAX_ATTEMPTS,
              ttlMs: PENDING_REFERENCE_TTL_MS,
              retryDelayMs: pendingReferenceRetryDelayMs,
            },
          ),
        );
        if (result !== "skipped") finalized += 1;
        this.logger.info("Pending-reference attempt completed", {
          transactionId: candidate.id,
          outcome: result,
        });
      } catch (error) {
        this.logger.error("Could not process pending wager reference", {
          transactionId: candidate.id,
          error,
        });
      }
    }
    return finalized;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error("Pending-reference worker cycle failed", { error });
      }
      await waitForNextCycle(this.pollIntervalMs, signal);
    }
  }
}
