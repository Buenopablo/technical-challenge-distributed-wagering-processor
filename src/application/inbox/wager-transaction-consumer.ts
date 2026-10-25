import { DataSource } from "typeorm";
import {
  isGlobalSqsConfigurationError,
  SqsConsumerClient,
  SqsReceivedMessage,
} from "../../messaging/sqs/sqs-publisher-client";
import { ProcessWagerTransactionUseCase } from "../wagering/process-wager-transaction.use-case";
import {
  InboxMessageIntegrityConflictError,
  PermanentWagerProcessingError,
  ProcessedWagerMessage,
  WagerTransactionInboxProcessor,
} from "./wager-transaction-inbox-processor";
import {
  InvalidWagerTransactionMessageError,
} from "../../messaging/contracts/wager-transaction-message";

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_ERROR_DELAY_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
const MAX_RETRY_VISIBILITY_SECONDS = 300;

export type WagerMessageProcessingOutcome =
  | "acknowledged"
  | "not-acknowledged";

export interface WagerTransactionConsumerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface WagerTransactionConsumerOptions {
  batchSize?: number;
  concurrency?: number;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  pollErrorDelayMs?: number;
  shutdownGraceMs?: number;
}

export interface WagerTransactionConsumerConfig {
  batchSize: number;
  concurrency: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  pollErrorDelayMs: number;
  shutdownGraceMs: number;
}

export interface WagerTransactionMessageProcessor {
  process(
    transportMessageId: string,
    body: string,
  ): Promise<ProcessedWagerMessage>;
}

interface MessageVisibilityHeartbeat {
  stop(): Promise<void>;
  deleteMessage(): Promise<void>;
}

type VisibilityOperationQueue = <T>(
  operation: () => Promise<T>,
) => Promise<{ executed: false } | { executed: true; value: T }>;

const defaultLogger: WagerTransactionConsumerLogger = {
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

function readInteger(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function readWagerTransactionConsumerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WagerTransactionConsumerConfig {
  const batchSize = readInteger(
    environment,
    "SQS_CONSUMER_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
    1,
    10,
  );
  const concurrency = readInteger(
    environment,
    "SQS_CONSUMER_CONCURRENCY",
    DEFAULT_CONCURRENCY,
    1,
    10,
  );
  return {
    batchSize,
    concurrency,
    waitTimeSeconds: readInteger(
      environment,
      "SQS_CONSUMER_WAIT_TIME_SECONDS",
      DEFAULT_WAIT_TIME_SECONDS,
      0,
      20,
    ),
    visibilityTimeoutSeconds: readInteger(
      environment,
      "SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS",
      DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
      1,
      43_200,
    ),
    pollErrorDelayMs: readInteger(
      environment,
      "SQS_CONSUMER_POLL_ERROR_DELAY_MS",
      DEFAULT_POLL_ERROR_DELAY_MS,
      1,
      60_000,
    ),
    shutdownGraceMs: readInteger(
      environment,
      "SQS_CONSUMER_SHUTDOWN_GRACE_MS",
      DEFAULT_SHUTDOWN_GRACE_MS,
      1,
      300_000,
    ),
  };
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

function databaseErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
    cause?: { code?: unknown };
  };
  const code =
    candidate.driverError?.code ??
    candidate.cause?.code ??
    candidate.code;
  return typeof code === "string" ? code : "";
}

function isTransientProcessingFailure(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return (
    code.startsWith("08") ||
    [
      "40001",
      "40P01",
      "55P03",
      "57P01",
      "57P02",
      "57P03",
      "53300",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "EPIPE",
    ].includes(code)
  );
}

function retryVisibilitySeconds(receiveCount: number): number {
  const attempt = Math.max(1, receiveCount);
  return Math.min(MAX_RETRY_VISIBILITY_SECONDS, 2 ** Math.min(attempt - 1, 8));
}

function processingFailureType(error: unknown): string {
  if (error instanceof InvalidWagerTransactionMessageError) {
    return "invalid-message";
  }
  if (error instanceof InboxMessageIntegrityConflictError) {
    return "inbox-integrity-conflict";
  }
  if (error instanceof PermanentWagerProcessingError) {
    return "permanent-business-error";
  }
  if (isTransientProcessingFailure(error)) {
    return "transient-infrastructure";
  }
  return "unclassified-processing-error";
}

export class WagerTransactionConsumer {
  private readonly config: WagerTransactionConsumerConfig;

  constructor(
    private readonly sqsClient: SqsConsumerClient,
    private readonly queueUrl: string,
    private readonly processor: WagerTransactionMessageProcessor,
    private readonly logger: WagerTransactionConsumerLogger = defaultLogger,
    options: WagerTransactionConsumerOptions = {},
  ) {
    this.config = {
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      waitTimeSeconds:
        options.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds:
        options.visibilityTimeoutSeconds ??
        DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
      pollErrorDelayMs:
        options.pollErrorDelayMs ?? DEFAULT_POLL_ERROR_DELAY_MS,
      shutdownGraceMs:
        options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    };
    this.validateConfig(this.config);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let messages: SqsReceivedMessage[];
      try {
        messages = await this.sqsClient.receiveMessages(
          this.queueUrl,
          {
            maxNumberOfMessages: Math.min(
              this.config.batchSize,
              this.config.concurrency,
            ),
            waitTimeSeconds: this.config.waitTimeSeconds,
            visibilityTimeoutSeconds: this.config.visibilityTimeoutSeconds,
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        if (isGlobalSqsConfigurationError(error)) {
          throw error;
        }
        this.logger.error("Could not receive wager transactions from SQS", {
          error: errorDetails(error),
        });
        await this.wait(this.config.pollErrorDelayMs, signal);
        continue;
      }

      if (messages.length === 0) {
        continue;
      }

      const groupedMessages = new Map<string, SqsReceivedMessage[]>();
      messages.forEach((message, index) => {
        const groupKey = message.messageGroupId ?? `unidentified-${index}`;
        const group = groupedMessages.get(groupKey) ?? [];
        group.push(message);
        groupedMessages.set(groupKey, group);
      });
      const heartbeats = messages.map((message) =>
        message.receiptHandle
          ? this.startVisibilityRenewal(message, message.receiptHandle)
          : undefined,
      );
      const heartbeatByReceipt = new Map(
        messages.flatMap((message, index) =>
          message.receiptHandle && heartbeats[index]
            ? [[message.receiptHandle, heartbeats[index]!] as const]
            : [],
        ),
      );
      let results: PromiseSettledResult<void>[];
      try {
        const processing = Promise.allSettled(
          [...groupedMessages.values()].map(async (group) => {
            for (const message of group) {
              const heartbeat = message.receiptHandle
                ? heartbeatByReceipt.get(message.receiptHandle)
                : undefined;
              const outcome = await this.processReceivedMessage(
                message,
                heartbeat,
              );
              if (outcome === "not-acknowledged") {
                break;
              }
            }
          }),
        );
        results = await this.awaitBatch(processing, signal, messages.length);
      } finally {
        const stopped = await Promise.allSettled(
          heartbeats.map((heartbeat) => heartbeat?.stop()),
        );
        const renewalFailure = stopped.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected" &&
            isGlobalSqsConfigurationError(result.reason),
        );
        if (renewalFailure) {
          throw renewalFailure.reason;
        }
      }
      const globalFailure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected" &&
          isGlobalSqsConfigurationError(result.reason),
      );
      if (globalFailure) {
        throw globalFailure.reason;
      }
    }
  }

  async processReceivedMessage(
    message: SqsReceivedMessage,
    heartbeat?: MessageVisibilityHeartbeat,
  ): Promise<WagerMessageProcessingOutcome> {
    if (message.body === undefined || !message.receiptHandle || !message.messageId) {
      this.logger.error("Received SQS wager message without required transport fields", {
        transportMessageId: message.messageId ?? null,
      });
      return "not-acknowledged";
    }

    const visibilityHeartbeat =
      heartbeat ??
      this.startVisibilityRenewal(message, message.receiptHandle);
    try {
      let processed: ProcessedWagerMessage;
      try {
        processed = await this.processor.process(
          message.messageId,
          message.body,
        );
      } catch (error) {
        const failureType = processingFailureType(error);
        this.logger.error("Wager message was not acknowledged", {
          failureType,
          messageId: message.messageId,
          receiveCount: message.approximateReceiveCount ?? null,
          error: errorDetails(error),
        });
        await visibilityHeartbeat.stop();
        if (isTransientProcessingFailure(error)) {
          await this.scheduleRetry(message);
        }
        return "not-acknowledged";
      }

      this.logger.info(
        processed.duplicate
          ? "Recognized previously processed wager message"
          : processed.terminalConflict
            ? "Acknowledging terminal idempotency conflict"
            : "Committed wager transaction and Inbox message",
        {
          consumerName: "wager-transaction-consumer",
          messageId: message.messageId,
          transactionId: processed.result?.transactionId ?? null,
          status: processed.result?.status ?? null,
          duplicate: processed.duplicate,
          ...(processed.terminalConflict ? { terminalConflict: true } : {}),
        },
      );

      try {
        await visibilityHeartbeat.deleteMessage();
      } catch (error) {
        this.logger.error("Wager transaction committed but SQS acknowledgement failed", {
          messageId: message.messageId,
          error: errorDetails(error),
        });
        if (isGlobalSqsConfigurationError(error)) {
          throw error;
        }
        return "not-acknowledged";
      }
      return "acknowledged";
    } finally {
      await visibilityHeartbeat.stop();
    }
  }

  private startVisibilityRenewal(
    message: SqsReceivedMessage,
    receiptHandle: string,
  ): MessageVisibilityHeartbeat {
    const controller = new AbortController();
    const consumer = this;
    let stopped = false;
    let ackStarted = false;
    let fatalError: unknown;
    let operations = Promise.resolve();
    const enqueue = <T>(
      operation: () => Promise<T>,
      isAck = false,
    ): Promise<{ executed: false } | { executed: true; value: T }> => {
      const result = operations.then(async () =>
        stopped || (ackStarted && !isAck)
          ? { executed: false as const }
          : { executed: true as const, value: await operation() },
      );
      operations = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const renewal = this.renewVisibilityUntilStopped(
      message,
      receiptHandle,
      controller.signal,
      enqueue,
      (error) => {
        fatalError = error;
      },
    );

    const stop = async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        controller.abort();
      }
      await renewal;
      await operations;
      if (fatalError) {
        throw fatalError;
      }
    };

    return {
      stop,
      async deleteMessage() {
        ackStarted = true;
        try {
          const result = await enqueue(
            () =>
              consumer.sqsClient.deleteMessage(
                consumer.queueUrl,
                receiptHandle,
              ),
            true,
          );
          if (stopped || !result.executed) {
            throw new Error("Message visibility heartbeat stopped before ACK");
          }
        } catch (error) {
          ackStarted = false;
          throw error;
        }
      },
    };
  }

  private async renewVisibilityUntilStopped(
    message: SqsReceivedMessage,
    receiptHandle: string,
    signal: AbortSignal,
    enqueue: VisibilityOperationQueue,
    onFatalError: (error: unknown) => void,
  ): Promise<void> {
    const intervalMs = Math.max(
      100,
      Math.floor((this.config.visibilityTimeoutSeconds * 1_000) / 2),
    );

    while (!signal.aborted) {
      await this.wait(intervalMs, signal);
      if (signal.aborted) {
        break;
      }

      try {
        await enqueue(() =>
          this.sqsClient.changeMessageVisibility(
            this.queueUrl,
            receiptHandle,
            this.config.visibilityTimeoutSeconds,
          ),
        );
      } catch (error) {
        this.logger.error("Could not renew visibility for in-flight wager message", {
          messageId: message.messageId ?? null,
          visibilityTimeoutSeconds: this.config.visibilityTimeoutSeconds,
          error: errorDetails(error),
        });
        if (isGlobalSqsConfigurationError(error)) {
          onFatalError(error);
          return;
        }
      }
    }
  }

  private async scheduleRetry(message: SqsReceivedMessage): Promise<void> {
    if (!message.receiptHandle) {
      return;
    }
    try {
      const delay = retryVisibilitySeconds(message.approximateReceiveCount ?? 1);
      await this.sqsClient.changeMessageVisibility(
        this.queueUrl,
        message.receiptHandle,
        delay,
      );
      this.logger.warn("Scheduled SQS redelivery after transient failure", {
        messageId: message.messageId ?? null,
        retryDelaySeconds: delay,
      });
    } catch (error) {
      this.logger.error("Could not change visibility for wager message retry", {
        messageId: message.messageId ?? null,
        error: errorDetails(error),
      });
      if (isGlobalSqsConfigurationError(error)) {
        throw error;
      }
    }
  }

  private validateConfig(config: WagerTransactionConsumerConfig): void {
    if (
      !Number.isInteger(config.batchSize) ||
      config.batchSize < 1 ||
      config.batchSize > 10
    ) {
      throw new Error("SQS consumer batch size must be between 1 and 10");
    }
    if (
      !Number.isInteger(config.concurrency) ||
      config.concurrency < 1 ||
      config.concurrency > 10
    ) {
      throw new Error("SQS consumer concurrency must be between 1 and 10");
    }
    if (
      !Number.isInteger(config.waitTimeSeconds) ||
      config.waitTimeSeconds < 0 ||
      config.waitTimeSeconds > 20
    ) {
      throw new Error("SQS consumer wait time must be between 0 and 20 seconds");
    }
    if (
      !Number.isInteger(config.visibilityTimeoutSeconds) ||
      config.visibilityTimeoutSeconds < 1 ||
      config.visibilityTimeoutSeconds > 43_200
    ) {
      throw new Error("SQS consumer visibility timeout must be between 1 and 43200 seconds");
    }
    if (!Number.isInteger(config.pollErrorDelayMs) || config.pollErrorDelayMs < 1) {
      throw new Error("SQS consumer poll error delay must be positive");
    }
    if (!Number.isInteger(config.shutdownGraceMs) || config.shutdownGraceMs < 1) {
      throw new Error("SQS consumer shutdown grace must be positive");
    }
  }

  private async awaitBatch(
    processing: Promise<PromiseSettledResult<void>[]>,
    signal: AbortSignal,
    count: number,
  ): Promise<PromiseSettledResult<void>[]> {
    if (!signal.aborted) {
      let abortListener: (() => void) | undefined;
      const outcome = await Promise.race([
        processing.then(() => "completed" as const),
        new Promise<"aborted">((resolve) => {
          abortListener = () => resolve("aborted");
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      ]);
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      if (outcome === "completed") {
        return processing;
      }
    }
    if (signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceElapsed = new Promise<"grace-elapsed">((resolve) => {
        timer = setTimeout(
          () => resolve("grace-elapsed"),
          this.config.shutdownGraceMs,
        );
      });
      const outcome = await Promise.race([
        processing.then(() => "completed" as const),
        graceElapsed,
      ]);
      if (timer) {
        clearTimeout(timer);
      }
      if (outcome === "grace-elapsed") {
        this.logger.warn(
          "Shutdown grace elapsed; waiting for active database work before closing resources",
          {
            inFlightMessages: count,
            shutdownGraceMs: this.config.shutdownGraceMs,
          },
        );
      }
    }
    return processing;
  }

  private async wait(delayMs: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

export function createWagerTransactionConsumer(
  dataSource: DataSource,
  sqsClient: SqsConsumerClient,
  queueUrl: string,
  logger: WagerTransactionConsumerLogger = defaultLogger,
  options: WagerTransactionConsumerOptions = {},
): WagerTransactionConsumer {
  return new WagerTransactionConsumer(
    sqsClient,
    queueUrl,
    new WagerTransactionInboxProcessor(
      dataSource,
      new ProcessWagerTransactionUseCase(dataSource),
    ),
    logger,
    options,
  );
}
