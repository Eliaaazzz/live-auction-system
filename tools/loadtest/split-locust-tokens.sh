#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  WORKERS=8 USERS=10000 TOKENS=.k6-tokens \
    tools/loadtest/split-locust-tokens.sh

Optional env:
  OUT_DIR=/tmp/lumen-locust-shards-* output artifact directory
  BASE_URL=http://115.191.76.40       HTTP target for bid command lane
  WS_HOST=ws://115.191.76.40          WebSocket target
  AID=<auction-id>                    load auction id; defaults to .k6-aid
  BID_COMMAND=http                    http or ws
  MASTER_HOST=<ip>                    Locust master private IP for command hints

Outputs:
  tokens-worker-NN.txt                disjoint token shard per worker
  workers.tsv                         no-secret worker command hints
  summary.env                         no-secret run metadata

This helper never prints token values. It only copies them into shard files.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 2
  }
}

need awk
need grep
need wc

tokens="${TOKENS:-.k6-tokens}"
workers="${WORKERS:-8}"
users="${USERS:-10000}"
base_url="${BASE_URL:-http://115.191.76.40}"
ws_host="${WS_HOST:-ws://115.191.76.40}"
bid_command="${BID_COMMAND:-http}"
master_host="${MASTER_HOST:-<master-private-ip>}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${OUT_DIR:-/tmp/lumen-locust-shards-${timestamp}}"

if [[ ! -f "$tokens" ]]; then
  echo "token file not found: $tokens" >&2
  usage >&2
  exit 2
fi
case "$workers:$users" in
  *[!0-9:]*|0:*|*:0|*:-*)
    echo "WORKERS and USERS must be positive integers" >&2
    exit 2
    ;;
esac
if (( workers < 1 )); then
  echo "WORKERS must be >= 1" >&2
  exit 2
fi

aid="${AID:-}"
if [[ -z "$aid" && -f .k6-aid ]]; then
  aid="$(cat .k6-aid)"
fi
if [[ -z "$aid" ]]; then
  echo "AID or .k6-aid is required" >&2
  exit 2
fi

mkdir -p "$out_dir"
canonical="$out_dir/tokens.canonical"
grep -E '^user_[^.]+\.[a-f0-9]{64}$' "$tokens" > "$canonical" || true
token_count="$(wc -l < "$canonical" | tr -d ' ')"
if (( token_count < users )); then
  echo "token_count=$token_count is lower than USERS=$users" >&2
  echo "generate more login tokens before the Beijing 10k run" >&2
  exit 2
fi

base_tokens=$((users / workers))
extra_tokens=$((users % workers))

{
  printf 'worker\ttokens\ttoken_file\tcommand\n'
  offset=0
  for ((w=0; w<workers; w++)); do
    shard_tokens=$base_tokens
    if (( w < extra_tokens )); then shard_tokens=$((shard_tokens + 1)); fi
    worker_id=$(printf '%02d' "$w")
    shard_file="$out_dir/tokens-worker-${worker_id}.txt"
    awk -v start=$((offset + 1)) -v end=$((offset + shard_tokens)) 'NR >= start && NR <= end { print }' \
      "$canonical" > "$shard_file"
    offset=$((offset + shard_tokens))
    cmd="RUNNER_REGION=cn-beijing LOAD_AUCTION_ID=${aid} TOKENS_FILE=${shard_file} BASE_URL=${base_url} WS_HOST=${ws_host} BID_COMMAND=${bid_command} scripts/beijing-locust-10k-evidence.sh worker --master-host ${master_host}"
    printf '%s\t%s\t%s\t%s\n' "$worker_id" "$shard_tokens" "$shard_file" "$cmd"
  done
} > "$out_dir/workers.tsv"

{
  echo "timestamp_utc=${timestamp}"
  echo "tokens_source=${tokens}"
  echo "out_dir=${out_dir}"
  echo "workers=${workers}"
  echo "users=${users}"
  echo "token_count=${token_count}"
  echo "base_url=${base_url}"
  echo "ws_host=${ws_host}"
  echo "aid=${aid}"
  echo "bid_command=${bid_command}"
} > "$out_dir/summary.env"

rm -f "$canonical"
echo "locust shard plan written to $out_dir"
echo "plan: $out_dir/workers.tsv"
