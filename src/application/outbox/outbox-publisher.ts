import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { InvalidIntegrationEventError } from "../../messaging/contracts/integration-event";
import {
  classifySqsPublishError,
  SqsPublisherClient,
} from "../../messaging/sqs/sqs-publisher-client";
import {
  OutboxEventRecord,
  reconstructOutboxEvent,
} from "./outbox-event";

const MAX_ATTEMPTS = 10;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface OutboxPublisherLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface OutboxPublisherOptions {
  batchSize?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  random?: () => number;
}

interface ClaimedOutboxEvent extends OutboxEventRecord {
  attempts: number;
  created_at: Date;
  next_attempt_at: Date;
}

export function calculateOutboxRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
  const jittered = exponential * (0.5 + random());
  return Math.min(Math.round(jittered), MAX_BACKOFF_MS);
}

function errorDetails(error: unknown): string {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, 2_000);
}

const defaultLogger: OutboxPublisherLogger = {
  info(message, context) {
    console.info(message, context ?? {});
  },
  warn(message, context) {
    console.warn(message, context ?? {});
  },
  error(message, context) {
    console.error(message, context ?? {});
  },
};

export class OutboxPublisher {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly random: () => number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sqsClient: SqsPublisherClient,
    private readonly queueUrl: string,
    private readonly logger: OutboxPublisherLogger = defaultLogger,
    options: OutboxPublisherOptions = {},
  ) {
    const requestedBatchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (
      !Number.isInteger(requestedBatchSize) ||
      requestedBatchSize < 1
    ) {
      throw new Error("Outbox publisher batch size must be a positive integer");
    }
    this.batchSize = Math.min(requestedBatchSize, DEFAULT_BATCH_SIZE);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 1) {
      throw new Error("Outbox publisher lease must be a positive duration");
    }
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.random = options.random ?? Math.random;
  }

  async publishAvailableBatch(): Promise<number> {
    const claimToken = randomUUID();
    const events = await this.claimEvents(claimToken);
    if (events.length === 0) {
      return 0;
    }

    this.logger.info("Claimed Outbox events", {
      count: events.length,
    });
    const eventsByAggregate = new Map<string, ClaimedOutboxEvent[]>();
    for (const event of events) {
      const group = eventsByAggregate.get(event.aggregate_id) ?? [];
      group.push(event);
      eventsByAggregate.set(event.aggregate_id, group);
    }
    const results = await Promise.allSettled(
      [...eventsByAggregate.values()].map(async (group) => {
        for (let index = 0; index < group.length; index += 1) {
          try {
            const mayContinue = await this.publishClaimedEvent(
              group[index],
              claimToken,
            );
            if (!mayContinue) {
              await this.releaseUnsentClaims(group.slice(index + 1), claimToken);
              return;
            }
          } catch (error) {
            await this.releaseUnsentClaims(group.slice(index + 1), claimToken);
            throw error;
          }
        }
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
    return events.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.publishAvailableBatch();
      } catch (error) {
        if (
          classifySqsPublishError(error) === "global-configuration"
        ) {
          throw error;
        }
        this.logger.error("Outbox publishing cycle failed", {
          error: errorDetails(error),
        });
      }
      if (!signal.aborted) {
        await this.waitForNextPoll(signal);
      }
    }
  }

  private async claimEvents(
    claimToken: string,
  ): Promise<ClaimedOutboxEvent[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE outbox_messages
         SET failed_at = now(),
             last_error = COALESCE(
               last_error,
               'Maximum Outbox publication attempts reached after claim recovery'
             ),
             claimed_by = NULL,
             claim_expires_at = NULL
         WHERE published_at IS NULL
           AND failed_at IS NULL
           AND attempts >= $1
           AND (claimed_by IS NULL OR claim_expires_at <= now())`,
        [MAX_ATTEMPTS],
      );

      const rows = (await manager.query(
        `WITH candidates AS (
           SELECT event_id
           FROM outbox_messages AS candidate
           WHERE published_at IS NULL
             AND failed_at IS NULL
             AND next_attempt_at <= now()
             AND attempts < $1
             AND (claimed_by IS NULL OR claim_expires_at <= now())
             AND NOT EXISTS (
               SELECT 1
               FROM outbox_messages AS earlier
               WHERE earlier.aggregate_id = candidate.aggregate_id
                 AND earlier.published_at IS NULL
                 AND earlier.failed_at IS NULL
                 AND (earlier.created_at, earlier.event_id) <
                     (candidate.created_at, candidate.event_id)
             )
           ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.event_id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         ), claimed AS (
           UPDATE outbox_messages AS outbox
           SET claimed_by = $3,
               claim_expires_at = now() + ($4 * interval '1 millisecond'),
               attempts = outbox.attempts + 1
           FROM candidates
           WHERE outbox.event_id = candidates.event_id
           RETURNING outbox.event_id,
                     outbox.event_type,
                     outbox.event_version,
                     outbox.aggregate_id,
                     outbox.occurred_at,
                     outbox.causation_id,
                     outbox.correlation_id,
                     outbox.payload,
                     outbox.attempts,
                     outbox.created_at,
                     outbox.next_attempt_at
         )
         SELECT * FROM claimed
         ORDER BY next_attempt_at, created_at, event_id`,
        [MAX_ATTEMPTS, this.batchSize, claimToken, this.leaseMs],
      )) as ClaimedOutboxEvent[];
      return rows;
    });
  }

  private async publishClaimedEvent(
    record: ClaimedOutboxEvent,
    claimToken: string,
  ): Promise<boolean> {
    let event;
    try {
      event = reconstructOutboxEvent(record);
    } catch (error) {
      if (!(error instanceof InvalidIntegrationEventError)) {
        throw error;
      }
      const terminalized = await this.markPermanentlyFailed(
        record.event_id,
        claimToken,
        error,
      );
      this.logger.error("Outbox event failed contract validation", {
        eventId: record.event_id,
        eventType: record.event_type,
        error: errorDetails(error),
      });
      return terminalized;
    }

    try {
      await this.sendWithClaimRenewal(record.event_id, claimToken, () =>
        this.sqsClient.sendMessage({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(event),
          MessageGroupId: event.aggregateId,
          MessageDeduplicationId: event.eventId,
        }),
      );
    } catch (error) {
      const classification = classifySqsPublishError(error);
      if (classification === "global-configuration") {
        await this.releaseAfterGlobalFailure(record.event_id, claimToken);
        throw error;
      }
      if (classification === "permanent-message") {
        return this.markPermanentlyFailed(record.event_id, claimToken, error);
      }
      const mayContinue = await this.scheduleRetry(record, claimToken, error);
      this.logger.warn("SQS publication failed; event was rescheduled", {
        eventId: record.event_id,
        attempts: record.attempts,
        classification,
        error: errorDetails(error),
      });
      return mayContinue;
    }

    const confirmed = await this.markPublished(record.event_id, claimToken);
    if (!confirmed) {
      this.logger.warn(
        "SQS accepted an event whose Outbox claim is no longer current",
        { eventId: record.event_id },
      );
    }
    return confirmed;
  }

  private async sendWithClaimRenewal(
    eventId: string,
    claimToken: string,
    send: () => Promise<void>,
  ): Promise<void> {
    const intervalMs = Math.max(1, Math.floor(this.leaseMs / 3));
    let renewalInProgress: Promise<void> | undefined;
    let claimLost = false;
    const timer = setInterval(() => {
      if (claimLost || renewalInProgress) {
        return;
      }
      renewalInProgress = this.renewClaim(eventId, claimToken)
        .then((renewed) => {
          if (!renewed) {
            claimLost = true;
            this.logger.warn("Outbox claim changed while SQS send was active", {
              eventId,
            });
          }
        })
        .catch((error: unknown) => {
          this.logger.error("Could not renew active Outbox claim", {
            eventId,
            error: errorDetails(error),
          });
        })
        .finally(() => {
          renewalInProgress = undefined;
        });
    }, intervalMs);

    try {
      await send();
    } finally {
      clearInterval(timer);
      await renewalInProgress;
    }
  }

  private async renewClaim(
    eventId: string,
    claimToken: string,
  ): Promise<boolean> {
    const rows = (await this.dataSource.manager.query(
      `UPDATE outbox_messages
       SET claim_expires_at = now() + ($3 * interval '1 millisecond')
       WHERE event_id = $1
         AND published_at IS NULL
         AND failed_at IS NULL
         AND claimed_by = $2
       RETURNING event_id`,
      [eventId, claimToken, this.leaseMs],
    )) as Array<{ event_id: string }>;
    return rows.length === 1;
  }

  private async markPublished(
    eventId: string,
    claimToken: string,
  ): Promise<boolean> {
    const rows = (await this.dataSource.manager.query(
      `WITH updated AS (
         UPDATE outbox_messages
         SET published_at = now(),
             last_error = NULL,
             claimed_by = NULL,
             claim_expires_at = NULL
         WHERE event_id = $1
           AND published_at IS NULL
           AND failed_at IS NULL
           AND claimed_by = $2
         RETURNING event_id
       )
       SELECT event_id FROM updated`,
      [eventId, claimToken],
    )) as Array<{ event_id: string }>;
    return rows.length === 1;
  }

  private async scheduleRetry(
    event: ClaimedOutboxEvent,
    claimToken: string,
    error: unknown,
  ): Promise<boolean> {
    const message = errorDetails(error);
    if (event.attempts >= MAX_ATTEMPTS) {
      return this.markPermanentlyFailed(event.event_id, claimToken, message);
    }
    const delayMs = calculateOutboxRetryDelayMs(event.attempts, this.random);
    const rows = (await this.dataSource.manager.query(
      `WITH updated AS (
         UPDATE outbox_messages
         SET last_error = $3,
             next_attempt_at = now() + ($4 * interval '1 millisecond'),
             claimed_by = NULL,
             claim_expires_at = NULL
         WHERE event_id = $1
           AND published_at IS NULL
           AND failed_at IS NULL
           AND claimed_by = $2
         RETURNING event_id
       )
       SELECT event_id FROM updated`,
      [event.event_id, claimToken, message, delayMs],
    )) as Array<{ event_id: string }>;
    if (rows.length !== 1) {
      this.logger.warn("Could not reschedule event because claim changed", {
        eventId: event.event_id,
      });
    }
    return false;
  }

  private async markPermanentlyFailed(
    eventId: string,
    claimToken: string,
    error: unknown,
  ): Promise<boolean> {
    const rows = (await this.dataSource.manager.query(
      `WITH updated AS (
         UPDATE outbox_messages
         SET failed_at = now(),
             last_error = $3,
             claimed_by = NULL,
             claim_expires_at = NULL
         WHERE event_id = $1
           AND published_at IS NULL
           AND failed_at IS NULL
           AND claimed_by = $2
         RETURNING event_id
       )
       SELECT event_id FROM updated`,
      [eventId, claimToken, errorDetails(error)],
    )) as Array<{ event_id: string }>;
    if (rows.length !== 1) {
      this.logger.warn("Could not mark event failed because claim changed", {
        eventId,
      });
    }
    return rows.length === 1;
  }

  private async releaseUnsentClaims(
    events: ClaimedOutboxEvent[],
    claimToken: string,
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    try {
      await this.dataSource.manager.query(
        `UPDATE outbox_messages
         SET attempts = GREATEST(attempts - 1, 0),
             claimed_by = NULL,
             claim_expires_at = NULL
         WHERE event_id = ANY($1::uuid[])
           AND published_at IS NULL
           AND failed_at IS NULL
           AND claimed_by = $2`,
        [events.map((event) => event.event_id), claimToken],
      );
    } catch (error) {
      this.logger.error("Could not release unprocessed Outbox claims", {
        eventIds: events.map((event) => event.event_id),
        error: errorDetails(error),
      });
      throw error;
    }
  }

  private async releaseAfterGlobalFailure(
    eventId: string,
    claimToken: string,
  ): Promise<void> {
    await this.dataSource.manager.query(
      `UPDATE outbox_messages
       SET attempts = GREATEST(attempts - 1, 0),
           claimed_by = NULL,
           claim_expires_at = NULL
       WHERE event_id = $1
         AND published_at IS NULL
         AND failed_at IS NULL
         AND claimed_by = $2`,
      [eventId, claimToken],
    );
  }

  private async waitForNextPoll(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = setTimeout(finish, this.pollIntervalMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
