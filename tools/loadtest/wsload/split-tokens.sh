#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  WORKERS=10 TOTAL_CONNS=99000 TOTAL_BIDDERS=1000 \
    tools/loadtest/wsload/split-tokens.sh

Optional env:
  TOKENS=.k6-tokens                  newline-delimited JWT tokens from k6-setup.sh
  OUT_DIR=/tmp/lumen-wsload-shards-* output artifact directory
  HOST_WS=ws://lumen:8080            command hint target
  AID=<auction-id>                   command hint auction id; defaults to .k6-aid when present
  RAMP=60s                           command hint ramp duration
  HOLD=10m                           command hint hold duration
  ALLOW_TOKEN_WRAP=0                 set 1 to allow wsload modulo token reuse

Outputs:
  tokens-worker-NN.txt               disjoint token shard per worker
  workers.tsv                        worker plan: conns, bidders, tokens, command hint
  summary.env                        machine-readable run metadata

This helper never logs token values. It only copies them into shard files.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing required tool: $name" >&2
    exit 2
  fi
}

need awk
need wc

tokens="${TOKENS:-.k6-tokens}"
workers="${WORKERS:-10}"
total_conns="${TOTAL_CONNS:-99000}"
total_bidders="${TOTAL_BIDDERS:-1000}"
host_ws="${HOST_WS:-ws://lumen:8080}"
ramp="${RAMP:-60s}"
hold="${HOLD:-10m}"
allow_wrap="${ALLOW_TOKEN_WRAP:-0}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="${OUT_DIR:-/tmp/lumen-wsload-shards-${timestamp}}"

if [[ ! -f "$tokens" ]]; then
  echo "token file not found: $tokens" >&2
  usage >&2
  exit 2
fi
case "$workers:$total_conns:$total_bidders" in
  *[!0-9:]*|0:*|*:0:*|*:-*)
    echo "WORKERS, TOTAL_CONNS, and TOTAL_BIDDERS must be positive integers" >&2
    exit 2
    ;;
esac
if (( workers < 1 )); then
  echo "WORKERS must be >= 1" >&2
  exit 2
fi
if (( total_bidders > total_conns + total_bidders )); then
  echo "TOTAL_BIDDERS is invalid" >&2
  exit 2
fi

aid="${AID:-}"
if [[ -z "$aid" && -f .k6-aid ]]; then
  aid="$(cat .k6-aid)"
fi

token_count="$(grep -Ec '^user_[^.]+\.[a-f0-9]{64}$' "$tokens" || true)"
requested_total=$((total_conns + total_bidders))
if (( token_count == 0 )); then
  echo "no canonical tokens found in $tokens" >&2
  exit 2
fi
if (( allow_wrap != 1 && token_count < requested_total )); then
  echo "token_count=$token_count is lower than TOTAL_CONNS+TOTAL_BIDDERS=$requested_total" >&2
  echo "rerun k6-setup.sh with more N_USERS, or set ALLOW_TOKEN_WRAP=1 for socket-only stress" >&2
  exit 2
fi

mkdir -p "$out_dir"

# Keep only canonical tokens, preserving k6-setup order. Split contiguous ranges so
# each worker has a disjoint token set and wsload's first-N bidder identities stay
# local to that worker's shard.
grep -E '^user_[^.]+\.[a-f0-9]{64}$' "$tokens" >"$out_dir/tokens.canonical"

base_tokens=$((token_count / workers))
extra_tokens=$((token_count % workers))
base_conns=$((total_conns / workers))
extra_conns=$((total_conns % workers))
base_bidders=$((total_bidders / workers))
extra_bidders=$((total_bidders % workers))

{
  printf 'worker\ttokens\tconns\tbidders\ttoken_file\tcommand\n'
  offset=0
  for ((w=0; w<workers; w++)); do
    shard_tokens=$base_tokens
    if (( w < extra_tokens )); then shard_tokens=$((shard_tokens + 1)); fi
    shard_conns=$base_conns
    if (( w < extra_conns )); then shard_conns=$((shard_conns + 1)); fi
    shard_bidders=$base_bidders
    if (( w < extra_bidders )); then shard_bidders=$((shard_bidders + 1)); fi

    worker_id=$(printf '%02d' "$w")
    shard_file="$out_dir/tokens-worker-${worker_id}.txt"
    awk -v start=$((offset + 1)) -v end=$((offset + shard_tokens)) 'NR >= start && NR <= end { print }' \
      "$out_dir/tokens.canonical" >"$shard_file"
    offset=$((offset + shard_tokens))

    cmd="./wsload -host ${host_ws} -aid ${aid:-<auction-id>} -tokens ${shard_file} -conns ${shard_conns} -bidders ${shard_bidders} -ramp ${ramp} -hold ${hold}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$worker_id" "$shard_tokens" "$shard_conns" "$shard_bidders" "$shard_file" "$cmd"
  done
} >"$out_dir/workers.tsv"

{
  echo "timestamp_utc=${timestamp}"
  echo "tokens_source=${tokens}"
  echo "out_dir=${out_dir}"
  echo "workers=${workers}"
  echo "token_count=${token_count}"
  echo "total_conns=${total_conns}"
  echo "total_bidders=${total_bidders}"
  echo "allow_token_wrap=${allow_wrap}"
  echo "host_ws=${host_ws}"
  echo "aid=${aid:-}"
  echo "ramp=${ramp}"
  echo "hold=${hold}"
} >"$out_dir/summary.env"

rm -f "$out_dir/tokens.canonical"
echo "wsload shard plan written to $out_dir"
echo "plan: $out_dir/workers.tsv"
