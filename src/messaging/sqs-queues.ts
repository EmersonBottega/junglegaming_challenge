import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

export class SqsQueues {
  readonly client: SQSClient;
  readonly region: string;
  readonly queueName: string;
  readonly dlqName: string;
  readonly eventsQueueName: string;
  readonly endpoint?: string;
  queueUrl?: string;
  dlqUrl?: string;
  eventsQueueUrl?: string;

  constructor() {
    this.region = required("AWS_REGION", "us-east-1");
    this.queueName = required("SQS_QUEUE_NAME", "wager-transactions.fifo");
    this.dlqName = required("SQS_DLQ_NAME", "wager-transactions-dlq.fifo");
    this.eventsQueueName = required("SQS_EVENTS_QUEUE_NAME", "wager-events.fifo");
    for (const queueName of [this.queueName, this.dlqName, this.eventsQueueName]) {
      if (!queueName.endsWith(".fifo")) {
        throw new Error(`FIFO queue name must end with .fifo: ${queueName}`);
      }
    }
    this.endpoint = process.env.SQS_ENDPOINT || undefined;
    this.client = new SQSClient({
      region: this.region,
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: required("AWS_ACCESS_KEY_ID", "test"),
        secretAccessKey: required("AWS_SECRET_ACCESS_KEY", "test"),
      },
    });
  }

  async ensureQueues(): Promise<void> {
    this.dlqUrl = await this.getOrCreate(this.dlqName);
    const [dlqAttributes] = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: this.dlqUrl,
      AttributeNames: ["QueueArn"],
    })).then((response) => [response.Attributes]);
    const dlqArn = dlqAttributes?.QueueArn;
    if (!dlqArn) throw new Error("SQS dead-letter queue has no QueueArn");

    const redrivePolicy = JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: "5",
    });
    this.queueUrl = await this.getOrCreate(this.queueName, {
      RedrivePolicy: redrivePolicy,
      VisibilityTimeout: "60",
      ReceiveMessageWaitTimeSeconds: "10",
    });
    this.eventsQueueUrl = await this.getOrCreate(this.eventsQueueName, {
      VisibilityTimeout: "60",
      ReceiveMessageWaitTimeSeconds: "10",
    });
  }

  async getQueueAttributes(queueUrl = this.queueUrl): Promise<Record<string, string>> {
    if (!queueUrl) throw new Error("SQS queue has not been initialized");
    const response = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["All"],
    }));
    return response.Attributes ?? {};
  }

  async checkReady(): Promise<void> {
    if (!this.queueUrl || !this.eventsQueueUrl || !this.dlqUrl) {
      throw new Error("SQS queues have not been initialized");
    }
    await Promise.all([
      this.getQueueAttributes(this.queueUrl),
      this.getQueueAttributes(this.eventsQueueUrl),
      this.getQueueAttributes(this.dlqUrl),
    ]);
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }

  private async getOrCreate(
    queueName: string,
    extraAttributes: Record<string, string> = {},
  ): Promise<string> {
    try {
      const existing = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (existing.QueueUrl) {
        const attributes = await this.client.send(new GetQueueAttributesCommand({
          QueueUrl: existing.QueueUrl,
          AttributeNames: ["FifoQueue", "ContentBasedDeduplication"],
        }));
        if (
          attributes.Attributes?.FifoQueue !== "true" ||
          attributes.Attributes?.ContentBasedDeduplication !== "false"
        ) {
          throw new Error(`Existing SQS queue ${queueName} has incompatible FIFO settings`);
        }
        if (Object.keys(extraAttributes).length > 0) {
          await this.client.send(new SetQueueAttributesCommand({
            QueueUrl: existing.QueueUrl,
            Attributes: extraAttributes,
          }));
        }
        return existing.QueueUrl;
      }
    } catch (error) {
      if (!isQueueMissing(error)) throw error;
    }

    const created = await this.client.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        ...extraAttributes,
      },
    }));
    if (!created.QueueUrl) throw new Error(`SQS did not return URL for queue ${queueName}`);
    return created.QueueUrl;
  }
}

function isQueueMissing(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "QueueDoesNotExist" || error.name === "AWS.SimpleQueueService.NonExistentQueue");
}
