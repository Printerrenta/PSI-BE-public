#!/bin/sh
set -eu
base=http://pubsub:8085/v1/projects/printer-rental-local
for attempt in $(seq 1 60); do
  if curl -fsS "$base/topics" >/dev/null; then break; fi
  sleep 2
done
topic() {
  curl -fsS "$base/topics/$1" >/dev/null 2>&1 || curl -fsS -X PUT "$base/topics/$1" -H 'Content-Type: application/json' -d '{}'
}
subscription() {
  name=$1 source=$2 target=$3
  payload="{\"topic\":\"projects/printer-rental-local/topics/$source-events-v1\",\"pushConfig\":{\"pushEndpoint\":\"http://$target-service:8080/internal/events\"},\"ackDeadlineSeconds\":30}"
  curl -fsS "$base/subscriptions/$name" >/dev/null 2>&1 || curl -fsS -X PUT "$base/subscriptions/$name" -H 'Content-Type: application/json' -d "$payload"
}
for service in rental metering billing; do topic "$service-events-v1"; done
subscription rental-notifications-v1 rental notification
subscription rental-metering-v1 rental metering
subscription rental-billing-v1 rental billing
subscription metering-billing-v1 metering billing
subscription metering-notifications-v1 metering notification
subscription billing-notifications-v1 billing notification
