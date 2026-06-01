#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tools/loadtest/wsload/summarize-workers.sh --plan /tmp/lumen-wsload-shards-*/workers.tsv --logs-dir /tmp/wsload-worker-logs

Inputs:
  --plan FILE       workers.tsv from split-tokens.sh.
  --logs-dir DIR    Directory containing per-worker wsload logs.
                   Accepted names: worker-NN.log, wsload-worker-NN.log, NN.log.
  --out FILE        Output shard summary TSV. Defaults to <logs-dir>/shards.tsv.

Output columns match scripts/v100k-evidence-gate.sh:
  worker target_conns connect_ok connect_fail closed_early

This helper does not read tokens and does not copy wsload logs. It only extracts
non-secret aggregate counts needed by the v100k evidence gate.
USAGE
}

plan=""
logs_dir=""
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      plan="${2:-}"
      shift 2
      ;;
    --logs-dir)
      logs_dir="${2:-}"
      shift 2
      ;;
    --out)
      out="${2:-}"
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
if [[ -z "$logs_dir" || ! -d "$logs_dir" ]]; then
  echo "--logs-dir must point to an existing directory" >&2
  usage >&2
  exit 2
fi
if [[ -z "$out" ]]; then
  out="$logs_dir/shards.tsv"
fi
mkdir -p "$(dirname "$out")"

find_log() {
  local worker="$1"
  local candidate
  for candidate in \
    "$logs_dir/worker-${worker}.log" \
    "$logs_dir/wsload-worker-${worker}.log" \
    "$logs_dir/${worker}.log" \
    "$logs_dir/worker-${worker}.txt" \
    "$logs_dir/wsload-worker-${worker}.txt" \
    "$logs_dir/${worker}.txt"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

extract_counts() {
  local log_file="$1"
  python3 - "$log_file" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="replace")
patterns = [
    re.compile(r"connect\s+OK\s+([0-9][0-9,]*)\s*/\s*FAIL\s+([0-9][0-9,]*)\s*/\s*closed[- ]early\s+([0-9][0-9,]*)", re.I),
    re.compile(r"connect_ok[=:]\s*([0-9][0-9,]*).*?connect_fail[=:]\s*([0-9][0-9,]*).*?closed_early[=:]\s*([0-9][0-9,]*)", re.I | re.S),
    re.compile(r"ok=([0-9][0-9,]*).*?fail=([0-9][0-9,]*).*?closed[_-]?early=([0-9][0-9,]*)", re.I | re.S),
]
for pattern in patterns:
    match = pattern.search(text)
    if match:
        vals = [v.replace(",", "") for v in match.groups()]
        print("\t".join(vals))
        sys.exit(0)
print("\t".join(["", "", ""]))
sys.exit(1)
PY
}

tmp_out="$out.tmp"
printf 'worker\ttarget_conns\tconnect_ok\tconnect_fail\tclosed_early\n' >"$tmp_out"
missing=0

while IFS=$'\t' read -r worker tokens conns bidders token_file command; do
  [[ "$worker" == "worker" || -z "$worker" ]] && continue
  target=$((conns + bidders))
  if log_file="$(find_log "$worker")"; then
    if counts="$(extract_counts "$log_file")"; then
      IFS=$'\t' read -r ok fail early <<<"$counts"
      printf '%s\t%s\t%s\t%s\t%s\n' "$worker" "$target" "$ok" "$fail" "$early" >>"$tmp_out"
    else
      echo "could not parse wsload counts for worker $worker: $log_file" >&2
      missing=$((missing + 1))
      printf '%s\t%s\t0\t%s\t%s\n' "$worker" "$target" "$target" "$target" >>"$tmp_out"
    fi
  else
    echo "missing log for worker $worker under $logs_dir" >&2
    missing=$((missing + 1))
    printf '%s\t%s\t0\t%s\t%s\n' "$worker" "$target" "$target" "$target" >>"$tmp_out"
  fi
done <"$plan"

mv "$tmp_out" "$out"
echo "wsload shard summary written to $out"
if [[ "$missing" -gt 0 ]]; then
  echo "workers_with_missing_or_unparsed_logs=$missing" >&2
  exit 1
fi
