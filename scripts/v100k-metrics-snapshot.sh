#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/v100k-metrics-snapshot.sh [--url URL] [--duration SECONDS] [--interval SECONDS] [--out-dir DIR]

Purpose:
  Capture no-secret server /metrics samples during a distributed v100k hold
  window and write a metrics.json file suitable for v100k-evidence-gate.sh.

Options:
  --url URL             Metrics endpoint. Default: http://localhost:8080/metrics
  --duration SECONDS    Total sampling duration. Default: 60
  --interval SECONDS    Seconds between samples. Default: 5
  --out-dir DIR         Evidence output directory.
  --target N            Expected active connections. Default: 100000.

Outputs:
  metrics-samples.jsonl Raw sampled metrics, one JSON object per line.
  metrics.json          Selected gate input: highest activeConns sample.
  summary.md            Human-readable capture summary.

The helper does not read env files or credentials. It only calls the configured
metrics URL and stores server aggregate counters.
USAGE
}

url="http://localhost:8080/metrics"
duration="60"
interval="5"
out_dir=""
target="${TARGET_CONNS:-100000}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      url="${2:-}"
      shift 2
      ;;
    --duration)
      duration="${2:-}"
      shift 2
      ;;
    --interval)
      interval="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    --target)
      target="${2:-}"
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

case "$duration:$interval:$target" in
  *[!0-9:]*|0:*|*:0:*|*:-*)
    echo "--duration, --interval, and --target must be positive integers" >&2
    exit 2
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to parse metrics JSON" >&2
  exit 2
fi
if command -v curl >/dev/null 2>&1; then
  fetch_cmd="curl -fsS"
elif command -v wget >/dev/null 2>&1; then
  fetch_cmd="wget -qO-"
else
  echo "curl or wget is required to fetch metrics" >&2
  exit 2
fi

if [ -z "$out_dir" ]; then
  out_dir="/tmp/lumen-v100k-metrics-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$out_dir"

samples_jsonl="$out_dir/metrics-samples.jsonl"
metrics_json="$out_dir/metrics.json"
summary_md="$out_dir/summary.md"
tmp_sample="$out_dir/.sample.json"
: > "$samples_jsonl"

json_number_expr='
  .activeConns // .active_connections // .ws.activeConns // 0
'

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"
deadline=$((started_epoch + duration))
sample_count=0
fetch_failures=0
best_active="-1"

while :; do
  now_epoch="$(date +%s)"
  if [ "$now_epoch" -gt "$deadline" ]; then
    break
  fi

  sampled_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if sh -c "$fetch_cmd \"\$1\"" sh "$url" > "$tmp_sample"; then
    if jq -e . "$tmp_sample" >/dev/null 2>&1; then
      sample_count=$((sample_count + 1))
      jq -c --arg sampledAt "$sampled_at" '. + {sampledAtUtc: $sampledAt}' "$tmp_sample" >> "$samples_jsonl"
      active="$(jq -er "$json_number_expr | numbers" "$tmp_sample" 2>/dev/null || printf '0')"
      if awk -v a="$active" -v b="$best_active" 'BEGIN { exit !((a + 0) > (b + 0)) }'; then
        best_active="$active"
        jq --arg sampledAt "$sampled_at" '. + {sampledAtUtc: $sampledAt}' "$tmp_sample" > "$metrics_json"
      fi
    else
      fetch_failures=$((fetch_failures + 1))
      printf '%s\tinvalid_json\n' "$sampled_at" >> "$out_dir/fetch-errors.tsv"
    fi
  else
    fetch_failures=$((fetch_failures + 1))
    printf '%s\tfetch_failed\n' "$sampled_at" >> "$out_dir/fetch-errors.tsv"
  fi

  now_epoch="$(date +%s)"
  if [ "$now_epoch" -ge "$deadline" ]; then
    break
  fi
  sleep "$interval"
done

rm -f "$tmp_sample"

if [ "$sample_count" -eq 0 ]; then
  echo "no valid metrics samples captured from $url" >&2
  exit 1
fi

selected_status="below_target"
if awk -v got="$best_active" -v want="$target" 'BEGIN { exit !((got + 0) >= (want + 0)) }'; then
  selected_status="at_or_above_target"
fi

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$summary_md" <<EOF_SUMMARY
# Lumen v100k metrics snapshot

- url: $url
- started_at_utc: $started_at
- finished_at_utc: $finished_at
- duration_seconds: $duration
- interval_seconds: $interval
- target_active_conns: $target
- valid_samples: $sample_count
- fetch_failures: $fetch_failures
- selected_active_conns: $best_active
- selected_status: $selected_status
- selected_metrics_json: $metrics_json
- raw_samples_jsonl: $samples_jsonl

The selected metrics file is the valid sample with the highest activeConns
observed during this capture window. Feed it to:

\`\`\`bash
scripts/v100k-evidence-gate.sh --metrics "$metrics_json" --shards <shards.tsv>
\`\`\`
EOF_SUMMARY

printf 'metrics_json=%s\nsamples=%s\nsummary=%s\nvalid_samples=%s\nfetch_failures=%s\nselected_active_conns=%s\n' \
  "$metrics_json" "$samples_jsonl" "$summary_md" "$sample_count" "$fetch_failures" "$best_active"
