import { describe, expect, jest, test } from "bun:test";
import {
  WagerTransactionConsumer,
  WagerTransactionMessageProcessor,
} from "../../src/application/inbox/wager-transaction-consumer";
import {
  SqsConsumerClient,
  SqsReceivedMessage,
} from "../../src/messaging/sqs/sqs-publisher-client";

const logger = { info() {}, warn() {}, error() {} };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

class TestSqsClient implements SqsConsumerClient {
  readonly deletedReceipts: string[] = [];
  readonly visibilityChanges: number[] = [];
  readonly visibilityReceipts: string[] = [];
  private receiveCount = 0;

  constructor(
    private readonly messages: SqsReceivedMessage[],
    private readonly abortController: AbortController,
    private readonly deleteBehavior?: (receiptHandle: string) => Promise<void>,
    private readonly visibilityBehavior?: (
      seconds: number,
    ) => Promise<void>,
  ) {}

  async getQueueUrl() {
    return "queue-url";
  }

  async receiveMessages() {
    this.receiveCount += 1;
    if (this.receiveCount > 1) {
      this.abortController.abort();
      return [];
    }
    return this.messages;
  }

  async deleteMessage(_url: string, receiptHandle: string) {
    await this.deleteBehavior?.(receiptHandle);
    this.deletedReceipts.push(receiptHandle);
    if (this.deletedReceipts.length === this.messages.length) {
      this.abortController.abort();
    }
  }

  async changeMessageVisibility(
    _url: string,
    receiptHandle: string,
    seconds: number,
  ) {
    this.visibilityChanges.push(seconds);
    this.visibilityReceipts.push(receiptHandle);
    await this.visibilityBehavior?.(seconds);
  }

  destroy() {}
}

function createClient(
  messages: SqsReceivedMessage[],
  abortController: AbortController,
): SqsConsumerClient {
  return new TestSqsClient(messages, abortController);
}

function receivedMessage(
  body: string,
  messageId: string,
  messageGroupId: string,
): SqsReceivedMessage {
  return { body, messageId, messageGroupId, receiptHandle: `receipt-${messageId}` };
}

function createConsumer(
  client: SqsConsumerClient,
  processor: WagerTransactionMessageProcessor,
  visibilityTimeoutSeconds = 30,
) {
  return new WagerTransactionConsumer(
    client,
    "queue-url",
    processor,
    logger,
    {
      batchSize: 2,
      concurrency: 2,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds,
      pollErrorDelayMs: 10,
      shutdownGraceMs: 50,
    },
  );
}

describe("financial SQS consumer FIFO group scheduling", () => {
  test("processes messages in one MessageGroupId sequentially", async () => {
    const controller = new AbortController();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];
    const processor: WagerTransactionMessageProcessor = {
      async process(_messageId, body) {
        order.push(body);
        if (body === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { messageId: _messageId, duplicate: false };
      },
    };
    const messages = [
      receivedMessage("first", "id-1", "wallet-1"),
      receivedMessage("second", "id-2", "wallet-1"),
    ];
    const consumer = createConsumer(
      createClient(messages, controller),
      processor,
    );

    const running = consumer.run(controller.signal);
    await firstStarted.promise;
    expect(order).toEqual(["first"]);
    releaseFirst.resolve();
    await running;
    expect(order).toEqual(["first", "second"]);
  });

  test("processes different MessageGroupIds concurrently", async () => {
    const controller = new AbortController();
    const bothStarted = deferred();
    const release = deferred();
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const processor: WagerTransactionMessageProcessor = {
      async process(messageId) {
        started.push(messageId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (started.length === 2) bothStarted.resolve();
        await release.promise;
        active -= 1;
        return { messageId, duplicate: false };
      },
    };
    const messages = [
      receivedMessage("first", "id-1", "wallet-1"),
      receivedMessage("second", "id-2", "wallet-2"),
    ];
    const consumer = createConsumer(
      createClient(messages, controller),
      processor,
    );

    const running = consumer.run(controller.signal);
    await bothStarted.promise;
    expect(maximumActive).toBe(2);
    release.resolve();
    await running;
    expect(started).toEqual(["id-1", "id-2"]);
  });

  test("does not process or acknowledge later messages in a group after processing failure", async () => {
    const controller = new AbortController();
    const attempted: string[] = [];
    const messages = [
      receivedMessage("first", "id-1", "wallet-1"),
      receivedMessage("second", "id-2", "wallet-1"),
    ];
    const client = new TestSqsClient(messages, controller);
    const consumer = createConsumer(client, {
      async process(messageId) {
        attempted.push(messageId);
        throw new Error("temporary processor failure");
      },
    });

    await consumer.run(controller.signal);

    expect(attempted).toEqual(["id-1"]);
    expect(client.deletedReceipts).toEqual([]);
  });

  test("does not advance a group after ACK failure", async () => {
    const controller = new AbortController();
    const attempted: string[] = [];
    const messages = [
      receivedMessage("first", "id-1", "wallet-1"),
      receivedMessage("second", "id-2", "wallet-1"),
    ];
    const client = new TestSqsClient(messages, controller, async (receipt) => {
      if (receipt === "receipt-id-1") {
        throw new Error("SQS delete failed");
      }
    });
    const consumer = createConsumer(client, {
      async process(messageId) {
        attempted.push(messageId);
        return { messageId, duplicate: false };
      },
    });

    await consumer.run(controller.signal);

    expect(attempted).toEqual(["id-1"]);
    expect(client.deletedReceipts).toEqual([]);
  });

  test("renews visibility for later messages waiting behind an in-flight group message", async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const firstStarted = deferred();
      const releaseFirst = deferred();
      const order: string[] = [];
      const messages = [
        receivedMessage("first", "id-1", "wallet-1"),
        receivedMessage("second", "id-2", "wallet-1"),
      ];
      const client = new TestSqsClient(messages, controller);
      const consumer = createConsumer(
        client,
        {
          async process(messageId, body) {
            order.push(body);
            if (body === "first") {
              firstStarted.resolve();
              await releaseFirst.promise;
            }
            return { messageId, duplicate: false };
          },
        },
        1,
      );

      const running = consumer.run(controller.signal);
      await firstStarted.promise;
      jest.advanceTimersByTime(500);
      await flushMicrotasks();

      expect(order).toEqual(["first"]);
      expect(client.visibilityReceipts).toContain("receipt-id-2");
      expect(client.deletedReceipts).toEqual([]);

      releaseFirst.resolve();
      await running;
      expect(order).toEqual(["first", "second"]);
      expect(client.deletedReceipts).toEqual(["receipt-id-1", "receipt-id-2"]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("schedules retry for known transient PostgreSQL and transport failures", async () => {
    for (const error of [
      { code: "40001" },
      { code: "40P01" },
      { code: "57P03" },
      { code: "53300" },
      { code: "ECONNRESET" },
    ]) {
      const controller = new AbortController();
      const message = receivedMessage("payload", "id-1", "wallet-1");
      const client = new TestSqsClient([message], controller);
      const consumer = createConsumer(client, {
        async process() {
          throw error;
        },
      });

      const result = await consumer.processReceivedMessage(message);
      expect(result).toBe("not-acknowledged");
      expect(client.visibilityChanges).toEqual([1]);
      expect(client.deletedReceipts).toEqual([]);
    }
  });

  test("does not schedule a retry for a permanent database constraint failure", async () => {
    const controller = new AbortController();
    const message = receivedMessage("payload", "id-1", "wallet-1");
    const client = new TestSqsClient([message], controller);
    const consumer = createConsumer(client, {
      async process() {
        throw { code: "23505" };
      },
    });

    const result = await consumer.processReceivedMessage(message);
    expect(result).toBe("not-acknowledged");
    expect(client.visibilityChanges).toEqual([]);
    expect(client.deletedReceipts).toEqual([]);
  });

  test("renews visibility while processing and stops after acknowledgement", async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const renewed = deferred();
      const releaseProcessor = deferred();
      const message = receivedMessage("payload", "id-1", "wallet-1");
      const client = new TestSqsClient(
        [message],
        controller,
        undefined,
        async () => renewed.resolve(),
      );
      const consumer = createConsumer(
        client,
        {
          async process(messageId) {
            await releaseProcessor.promise;
            return { messageId, duplicate: false };
          },
        },
        1,
      );

      const processing = consumer.processReceivedMessage(message);
      await flushMicrotasks();
      jest.advanceTimersByTime(500);
      await renewed.promise;
      expect(client.visibilityChanges).toEqual([1]);
      releaseProcessor.resolve();
      expect(await processing).toBe("acknowledged");
      jest.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect(client.deletedReceipts).toEqual(["receipt-id-1"]);
      expect(client.visibilityChanges).toEqual([1]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("logs failed visibility renewal without treating it as successful", async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const renewalFailed = deferred();
      const releaseProcessor = deferred();
      const errors: string[] = [];
      const message = receivedMessage("payload", "id-1", "wallet-1");
      const client = new TestSqsClient(
        [message],
        controller,
        undefined,
        async () => {
          renewalFailed.resolve();
          throw new Error("visibility extension rejected");
        },
      );
      const consumer = new WagerTransactionConsumer(
        client,
        "queue-url",
        {
          async process(messageId) {
            await releaseProcessor.promise;
            return { messageId, duplicate: false };
          },
        },
        {
          ...logger,
          error(messageText) {
            errors.push(messageText);
          },
        },
        {
          batchSize: 1,
          concurrency: 1,
          waitTimeSeconds: 0,
          visibilityTimeoutSeconds: 1,
          pollErrorDelayMs: 10,
          shutdownGraceMs: 50,
        },
      );

      const processing = consumer.processReceivedMessage(message);
      jest.advanceTimersByTime(500);
      await renewalFailed.promise;
      await flushMicrotasks();
      releaseProcessor.resolve();
      expect(await processing).toBe("acknowledged");

      expect(client.visibilityChanges).toEqual([1]);
      expect(client.deletedReceipts).toEqual(["receipt-id-1"]);
      expect(errors).toContain(
        "Could not renew visibility for in-flight wager message",
      );
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("stops renewal before scheduling retry after a processing failure", async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const renewed = deferred();
      const message = receivedMessage("payload", "id-1", "wallet-1");
      const client = new TestSqsClient(
        [message],
        controller,
        undefined,
        async () => renewed.resolve(),
      );
      const consumer = createConsumer(
        client,
        {
          async process() {
            await renewed.promise;
            throw { code: "40001" };
          },
        },
        1,
      );

      const processing = consumer.processReceivedMessage(message);
      jest.advanceTimersByTime(500);
      await renewed.promise;
      expect(await processing).toBe("not-acknowledged");
      expect(client.visibilityChanges).toEqual([1, 1]);
      jest.advanceTimersByTime(1_000);
      await flushMicrotasks();
      expect(client.visibilityChanges).toEqual([1, 1]);
      expect(client.deletedReceipts).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps renewal alive during graceful shutdown until in-flight work finishes", async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const renewed = deferred();
      const started = deferred();
      const releaseProcessor = deferred();
      const message = receivedMessage("payload", "id-1", "wallet-1");
      const client = new TestSqsClient(
        [message],
        controller,
        undefined,
        async () => renewed.resolve(),
      );
      const consumer = createConsumer(
        client,
        {
          async process(messageId) {
            started.resolve();
            await releaseProcessor.promise;
            return { messageId, duplicate: false };
          },
        },
        1,
      );

      const running = consumer.run(controller.signal);
      await started.promise;
      jest.advanceTimersByTime(500);
      await renewed.promise;
      controller.abort();
      releaseProcessor.resolve();
      await running;
      expect(client.deletedReceipts).toEqual(["receipt-id-1"]);
      expect(client.visibilityChanges).toEqual([1]);
      jest.advanceTimersByTime(1_000);
      await flushMicrotasks();
      expect(client.visibilityChanges).toEqual([1]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
