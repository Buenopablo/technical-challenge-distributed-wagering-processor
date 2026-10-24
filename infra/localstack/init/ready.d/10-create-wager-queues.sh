#!/bin/sh
set -eu

region="${AWS_DEFAULT_REGION:-us-east-1}"
dead_letter_queue="${SQS_WAGER_TRANSACTIONS_DLQ:-wager-transactions-dlq.fifo}"
transactions_queue="${SQS_WAGER_TRANSACTIONS_QUEUE:-wager-transactions.fifo}"

case "$transactions_queue" in
  *.fifo) ;;
  *) echo "SQS_WAGER_TRANSACTIONS_QUEUE must end in .fifo" >&2; exit 1 ;;
esac
case "$dead_letter_queue" in
  *.fifo) ;;
  *) echo "SQS_WAGER_TRANSACTIONS_DLQ must end in .fifo" >&2; exit 1 ;;
esac
if [ "$transactions_queue" = "$dead_letter_queue" ]; then
  echo "The transaction queue and its DLQ must have different names" >&2
  exit 1
fi

dead_letter_attributes='{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20"}'
dead_letter_url="$(
  awslocal sqs create-queue \
    --region "$region" \
    --queue-name "$dead_letter_queue" \
    --attributes "$dead_letter_attributes" \
    --query QueueUrl \
    --output text
)"
dead_letter_arn="$(
  awslocal sqs get-queue-attributes \
    --region "$region" \
    --queue-url "$dead_letter_url" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn \
    --output text
)"

redrive_policy="$(
  printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$dead_letter_arn"
)"
escaped_redrive_policy="$(
  printf '%s' "$redrive_policy" | sed 's/"/\\"/g'
)"
transactions_attributes="$(
  printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20","RedrivePolicy":"%s"}' \
    "$escaped_redrive_policy"
)"

awslocal sqs create-queue \
  --region "$region" \
  --queue-name "$transactions_queue" \
  --attributes "$transactions_attributes" \
  --output text >/dev/null

echo "Provisioned SQS queues: $transactions_queue and $dead_letter_queue"
