#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tools/loadtest/wsload/run-worker.sh --plan /tmp/lumen-wsload-shards-*/workers.tsv --worker 00

Required:
  --plan FILE       workers.tsv from split-tokens.sh.
  --worker NN       Worker id from the first column of workers.tsv. "0" is accepted as "00".

Optional:
  --bin FILE        wsload binary to execute. Defaults to ./wsload.
  --logs-dir DIR    Directory for worker logs. Defaults to <plan-dir>/worker-logs.
  --host URL        Override HOST_WS from summary.env / workers.tsv. Defaults to ws://lumen:8080.
  --aid ID          Override auction id from summary.env / .k6-aid.
  --ramp DURATION   Override ramp duration. Defaults to summary.env or 60s.
  --hold DURATION   Override hold duration. Defaults to summary.env or 10m.

Output:
  worker-NN.log     wsload stdout/stderr, suitable for summarize-workers.sh.

This helper does not print token values. It passes the worker's token shard path
to wsload and writes only aggregate wsload output to the log.
USAGE
}

plan=""
worker=""
bin="./wsload"
logs_dir=""
host=""
aid=""
ramp=""
hold=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      plan="${2:-}"
      shift 2
      ;;
    --worker)
      worker="${2:-}"
      shift 2
      ;;
    --bin)
      bin="${2:-}"
      shift 2
      ;;
    --logs-dir)
      logs_dir="${2:-}"
      shift 2
      ;;
    --host)
      host="${2:-}"
      shift 2
      ;;
    --aid)
      aid="${2:-}"
      shift 2
      ;;
    --ramp)
      ramp="${2:-}"
      shift 2
      ;;
    --hold)
      hold="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$plan" || ! -f "$plan" ]]; then
  echo "--plan must point to workers.tsv" >&2
  usage >&2
  exit 2
fi
if [[ -z "$worker" ]]; then
  echo "--worker is required" >&2
  usage >&2
  exit 2
fi
if [[ "$worker" =~ ^[0-9]+$ ]]; then
  printf -v worker '%02d' "$((10#$worker))"
fi
if [[ ! -x "$bin" ]]; then
  echo "--bin must point to an executable wsload binary: $bin" >&2
  exit 2
fi

plan_dir="$(cd "$(dirname "$plan")" && pwd)"
summary_env="$plan_dir/summary.env"
default_host="ws://lumen:8080"
default_aid=""
default_ramp="60s"
default_hold="10m"

if [[ -f "$summary_env" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      host_ws) default_host="$value" ;;
      aid) default_aid="$value" ;;
      ramp) default_ramp="$value" ;;
      hold) default_hold="$value" ;;
    esac
  done <"$summary_env"
fi

if [[ -z "$aid" && -z "$default_aid" && -f .k6-aid ]]; then
  default_aid="$(cat .k6-aid)"
fi

host="${host:-$default_host}"
aid="${aid:-$default_aid}"
ramp="${ramp:-$default_ramp}"
hold="${hold:-$default_hold}"
logs_dir="${logs_dir:-$plan_dir/worker-logs}"

if [[ -z "$aid" ]]; then
  echo "auction id is required; pass --aid or keep aid=... in $summary_env" >&2
  exit 2
fi

row_worker=""
tokens=""
conns=""
bidders=""
token_file=""
command_hint=""
while IFS=$'\t' read -r candidate_worker candidate_tokens candidate_conns candidate_bidders candidate_token_file candidate_command_hint; do
  [[ "$candidate_worker" == "worker" || -z "$candidate_worker" ]] && continue
  if [[ "$candidate_worker" == "$worker" ]]; then
    row_worker="$candidate_worker"
    tokens="$candidate_tokens"
    conns="$candidate_conns"
    bidders="$candidate_bidders"
    token_file="$candidate_token_file"
    command_hint="$candidate_command_hint"
    break
  fi
done <"$plan"

if [[ -z "$row_worker" ]]; then
  echo "worker $worker not found in $plan" >&2
  exit 2
fi
if [[ -z "$conns" || -z "$bidders" || -z "$token_file" ]]; then
  echo "malformed workers.tsv row for worker $worker" >&2
  exit 2
fi
if [[ ! -f "$token_file" ]]; then
  echo "token shard not found for worker $worker: $token_file" >&2
  exit 2
fi

mkdir -p "$logs_dir"
log_file="$logs_dir/worker-${worker}.log"
target=$((conns + bidders))

{
  echo "worker=$worker"
  echo "target_conns=$target"
  echo "conns=$conns"
  echo "bidders=$bidders"
  echo "host=$host"
  echo "aid=$aid"
  echo "ramp=$ramp"
  echo "hold=$hold"
  echo "tokens_file=$token_file"
  echo "log_file=$log_file"
  echo "started_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$log_file"

set +e
"$bin" \
  -host "$host" \
  -aid "$aid" \
  -tokens "$token_file" \
  -conns "$conns" \
  -bidders "$bidders" \
  -ramp "$ramp" \
  -hold "$hold" 2>&1 | tee -a "$log_file"
status=${PIPESTATUS[0]}
set -e

{
  echo "finished_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "worker_exit=$status"
} >>"$log_file"

echo "wsload worker $worker log written to $log_file"
exit "$status"
