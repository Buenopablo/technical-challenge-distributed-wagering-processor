import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsPublisherConfig {
  region: string;
  endpoint?: string;
  queueName: string;
}

export interface SqsMessageInput {
  QueueUrl: string;
  MessageBody: string;
  MessageGroupId: string;
  MessageDeduplicationId: string;
}

export interface SqsPublisherClient {
  getQueueUrl(queueName: string): Promise<string>;
  sendMessage(input: SqsMessageInput): Promise<void>;
  destroy(): void;
}

export function readSqsPublisherConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SqsPublisherConfig {
  const region = environment.AWS_REGION?.trim() || "us-east-1";
  const queueName =
    environment.SQS_WAGER_INTEGRATION_EVENTS_QUEUE?.trim() ||
    "wager-integration-events.fifo";
  const endpoint = environment.SQS_ENDPOINT?.trim() || undefined;

  if (!queueName.endsWith(".fifo")) {
    throw new Error(
      "SQS_WAGER_INTEGRATION_EVENTS_QUEUE must name a FIFO queue ending in .fifo",
    );
  }

  if (endpoint) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error("SQS_ENDPOINT must be a valid HTTP(S) URL");
    }
    if (
      (parsedEndpoint.protocol !== "http:" &&
        parsedEndpoint.protocol !== "https:") ||
      !parsedEndpoint.hostname
    ) {
      throw new Error("SQS_ENDPOINT must be a valid HTTP(S) URL");
    }
  }

  return { region, queueName, ...(endpoint ? { endpoint } : {}) };
}

export function createSqsPublisherClient(
  config: SqsPublisherConfig,
): SqsPublisherClient {
  const client = new SQSClient({
    region: config.region,
    maxAttempts: 1,
    ...(config.endpoint
      ? {
          endpoint: config.endpoint,
          credentials: {
            accessKeyId: "localstack",
            secretAccessKey: "localstack",
          },
        }
      : {}),
  });

  return {
    async getQueueUrl(queueName) {
      const response = await client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      if (!response.QueueUrl) {
        throw new Error(`SQS did not return a URL for queue ${queueName}`);
      }
      return response.QueueUrl;
    },
    async sendMessage(input) {
      await client.send(
        new SendMessageCommand(input),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
    },
    destroy() {
      client.destroy();
    },
  };
}

export type SqsPublishErrorClassification =
  | "global-configuration"
  | "permanent-message"
  | "transient"
  | "unknown";

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
  };
  if (typeof candidate.Code === "string") {
    return candidate.Code;
  }
  if (typeof candidate.code === "string") {
    return candidate.code;
  }
  return typeof candidate.name === "string" ? candidate.name : "";
}

export function classifySqsPublishError(
  error: unknown,
): SqsPublishErrorClassification {
  const code = errorCode(error);
  const globalConfigurationErrors = new Set([
    "AccessDenied",
    "AccessDeniedException",
    "CredentialsProviderError",
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidAddress",
    "InvalidClientTokenId",
    "InvalidParameterValue",
    "InvalidSecurity",
    "InvalidSignatureException",
    "KmsAccessDeniedException",
    "KmsDisabledException",
    "KmsInvalidKeyUsageException",
    "KmsInvalidStateException",
    "KmsNotFoundException",
    "KmsOptInRequired",
    "MissingAuthenticationToken",
    "QueueDoesNotExist",
    "SignatureDoesNotMatch",
    "UnrecognizedClientException",
  ]);
  if (globalConfigurationErrors.has(code)) {
    return "global-configuration";
  }

  if (
    ["InvalidMessageContents", "MessageTooLong"].includes(code)
  ) {
    return "permanent-message";
  }

  const metadata =
    typeof error === "object" && error !== null && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
      : undefined;
  const statusCode = metadata?.httpStatusCode;
  if (
    typeof statusCode === "number" &&
    (statusCode === 429 || statusCode >= 500)
  ) {
    return "transient";
  }

  const transientErrors = new Set([
    "AbortError",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "InternalError",
    "KmsThrottledException",
    "RequestTimeout",
    "RequestTimeoutException",
    "RequestThrottled",
    "ServiceUnavailable",
    "TimeoutError",
    "Throttling",
    "ThrottlingException",
  ]);
  if (transientErrors.has(code)) {
    return "transient";
  }

  return "unknown";
}

export function isGlobalSqsConfigurationError(error: unknown): boolean {
  return classifySqsPublishError(error) === "global-configuration";
}
