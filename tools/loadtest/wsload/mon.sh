#!/usr/bin/env bash
# Sample the gateway /metrics N times every IV seconds. Usage: mon.sh [N] [IV]
N="${1:-1}"; IV="${2:-5}"
GW="${GW:-http://115.191.76.40}"
for i in $(seq 1 "$N"); do
  printf 't=%02ds ' "$(( i * IV ))"
  curl -s --max-time 8 "$GW/metrics" | jq -c '{activeConns, ack:.ackLatencyMs, bcast:.broadcastLatencyMs, patch:.roomStatePatchLatencyMs, catchup:.catchupLatencyMs, seqGap:.seqGapCount, bpClose:.backpressureForceClose, bidsAcc:.bidsAccepted, bidsRej:.bidsRejected}'
  sleep "$IV"
done
