#!/bin/sh
set -eu

region="${AWS_DEFAULT_REGION:-us-east-1}"
dead_letter_queue="${SQS_WAGER_TRANSACTIONS_DLQ:-wager-transactions-dlq.fifo}"
transactions_queue="${SQS_WAGER_TRANSACTIONS_QUEUE:-wager-transactions.fifo}"
integration_events_queue="${SQS_WAGER_INTEGRATION_EVENTS_QUEUE:-wager-integration-events.fifo}"
integration_events_dlq="${SQS_WAGER_INTEGRATION_EVENTS_DLQ:-wager-integration-events-dlq.fifo}"

case "$transactions_queue" in
  *.fifo) ;;
  *) echo "SQS_WAGER_TRANSACTIONS_QUEUE must end in .fifo" >&2; exit 1 ;;
esac
case "$dead_letter_queue" in
  *.fifo) ;;
  *) echo "SQS_WAGER_TRANSACTIONS_DLQ must end in .fifo" >&2; exit 1 ;;
esac
case "$integration_events_queue" in
  *.fifo) ;;
  *) echo "SQS_WAGER_INTEGRATION_EVENTS_QUEUE must end in .fifo" >&2; exit 1 ;;
esac
case "$integration_events_dlq" in
  *.fifo) ;;
  *) echo "SQS_WAGER_INTEGRATION_EVENTS_DLQ must end in .fifo" >&2; exit 1 ;;
esac
if [ "$transactions_queue" = "$dead_letter_queue" ] ||
  [ "$transactions_queue" = "$integration_events_queue" ] ||
  [ "$dead_letter_queue" = "$integration_events_queue" ] ||
  [ "$transactions_queue" = "$integration_events_dlq" ] ||
  [ "$dead_letter_queue" = "$integration_events_dlq" ] ||
  [ "$integration_events_queue" = "$integration_events_dlq" ]; then
  echo "Transaction, integration-events, and DLQ queues must have different names" >&2
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
transactions_base_attributes='{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20"}'
if transactions_queue_url="$(
  awslocal sqs get-queue-url \
    --region "$region" \
    --queue-name "$transactions_queue" \
    --query QueueUrl \
    --output text 2>/dev/null
)"; then
  :
else
  transactions_queue_url="$(
    awslocal sqs create-queue \
      --region "$region" \
      --queue-name "$transactions_queue" \
      --attributes "$transactions_base_attributes" \
      --query QueueUrl \
      --output text
  )"
fi
transactions_attributes="$(
  printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20","RedrivePolicy":"%s"}' \
    "$escaped_redrive_policy"
)"

awslocal sqs set-queue-attributes \
  --region "$region" \
  --queue-url "$transactions_queue_url" \
  --attributes "$transactions_attributes" \
  --output text >/dev/null

integration_events_dlq_attributes='{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20"}'
integration_events_dlq_url="$(
  awslocal sqs create-queue \
    --region "$region" \
    --queue-name "$integration_events_dlq" \
    --attributes "$integration_events_dlq_attributes" \
    --query QueueUrl \
    --output text
)"
integration_events_dlq_arn="$(
  awslocal sqs get-queue-attributes \
    --region "$region" \
    --queue-url "$integration_events_dlq_url" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn \
    --output text
)"
integration_events_redrive_policy="$(
  printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$integration_events_dlq_arn"
)"
escaped_integration_events_redrive_policy="$(
  printf '%s' "$integration_events_redrive_policy" | sed 's/"/\\"/g'
)"
integration_events_base_attributes='{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20"}'
if integration_events_queue_url="$(
  awslocal sqs get-queue-url \
    --region "$region" \
    --queue-name "$integration_events_queue" \
    --query QueueUrl \
    --output text 2>/dev/null
)"; then
  :
else
  integration_events_queue_url="$(
    awslocal sqs create-queue \
      --region "$region" \
      --queue-name "$integration_events_queue" \
      --attributes "$integration_events_base_attributes" \
      --query QueueUrl \
      --output text
  )"
fi
integration_events_attributes="$(
  printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"20","RedrivePolicy":"%s"}' \
    "$escaped_integration_events_redrive_policy"
)"

awslocal sqs set-queue-attributes \
  --region "$region" \
  --queue-url "$integration_events_queue_url" \
  --attributes "$integration_events_attributes" \
  --output text >/dev/null

echo "Provisioned SQS queues: $transactions_queue, $integration_events_queue, $dead_letter_queue, and $integration_events_dlq"
