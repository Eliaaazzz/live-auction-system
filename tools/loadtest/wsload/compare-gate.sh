#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tools/loadtest/wsload/compare-gate.sh --compare-dir DIR [--out-dir DIR]

Purpose:
  Gate the artifact directory produced by tools/loadtest/wsload/compare-refs.sh.
  This does not run wsload. It turns a completed base-vs-head comparison into a
  reviewable pass/fail report for the #118/#151 coalescing readiness gate.

Inputs expected under --compare-dir:
  manifest.env
  base/summary.env
  base/wsload.log
  base/final-metrics.json
  base/replay-verify.log
  head/summary.env
  head/wsload.log
  head/final-metrics.json
  head/replay-verify.log

Environment thresholds:
  ACK_P95_MAX_MS=80
  BROADCAST_P95_MAX_MS=150
  ACK_P95_REGRESSION_PCT=10
  BROADCAST_P95_REGRESSION_PCT=10
  PEAK_CONN_MIN_RATIO=0.95
USAGE
}

compare_dir=""
out_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compare-dir)
      compare_dir="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
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

if [[ -z "$compare_dir" || ! -d "$compare_dir" ]]; then
  echo "--compare-dir must point to an existing compare-refs artifact directory" >&2
  usage >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

ACK_P95_MAX_MS="${ACK_P95_MAX_MS:-80}"
BROADCAST_P95_MAX_MS="${BROADCAST_P95_MAX_MS:-150}"
ACK_P95_REGRESSION_PCT="${ACK_P95_REGRESSION_PCT:-10}"
BROADCAST_P95_REGRESSION_PCT="${BROADCAST_P95_REGRESSION_PCT:-10}"
PEAK_CONN_MIN_RATIO="${PEAK_CONN_MIN_RATIO:-0.95}"

if [[ -z "$out_dir" ]]; then
  out_dir="$compare_dir/gate"
fi
mkdir -p "$out_dir"

gate_tsv="$out_dir/gate.tsv"
summary_md="$out_dir/summary.md"
metrics_tsv="$out_dir/metrics.tsv"
: > "$gate_tsv"
printf 'check\tstatus\tobserved\tthreshold\tdetail\n' > "$gate_tsv"
printf 'side\twsload_status\tpeak_concurrent\tconnect_fail\tclosed_early\tack_p95_ms\tbroadcast_p95_ms\tseq_gap_count\tbackpressure_force_close\treplay_consistent\n' > "$metrics_tsv"

failures=0

record() {
  local check_name="$1"
  local status="$2"
  local observed="$3"
  local threshold="$4"
  local detail="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$check_name" "$status" "$observed" "$threshold" "$detail" >> "$gate_tsv"
  if [[ "$status" == "FAIL" ]]; then
    failures=$((failures + 1))
  fi
}

num_or_empty() {
  local filter="$1"
  local file="$2"
  jq -er "$filter | if type == \"number\" then . elif type == \"string\" then tonumber? else empty end" "$file" 2>/dev/null || true
}

env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1; exit } END { if (!found) exit 1 }' "$file" 2>/dev/null || true
}

strip_commas() {
  tr -d ','
}

log_number() {
  local pattern="$1"
  local file="$2"
  sed -nE "$pattern" "$file" 2>/dev/null | tail -n 1 | strip_commas
}

replay_consistent() {
  local file="$1"
  if grep -qi 'consistent:' "$file" 2>/dev/null; then
    echo "1"
  else
    echo "0"
  fi
}

cmp_le() {
  awk -v observed="$1" -v threshold="$2" 'BEGIN { exit((observed + 0) <= (threshold + 0) ? 0 : 1) }'
}

cmp_ge() {
  awk -v observed="$1" -v threshold="$2" 'BEGIN { exit((observed + 0) >= (threshold + 0) ? 0 : 1) }'
}

cmp_eq_zero() {
  awk -v observed="$1" 'BEGIN { exit((observed + 0) == 0 ? 0 : 1) }'
}

required_file() {
  local rel="$1"
  if [[ -f "$compare_dir/$rel" ]]; then
    record "artifact:$rel" "PASS" "present" "present" "required artifact exists"
  else
    record "artifact:$rel" "FAIL" "missing" "present" "required artifact missing"
  fi
}

for rel in \
  manifest.env \
  base/summary.env base/wsload.log base/final-metrics.json base/replay-verify.log \
  head/summary.env head/wsload.log head/final-metrics.json head/replay-verify.log; do
  required_file "$rel"
done

collect_side() {
  local side="$1"
  local summary="$compare_dir/$side/summary.env"
  local log="$compare_dir/$side/wsload.log"
  local metrics="$compare_dir/$side/final-metrics.json"
  local replay="$compare_dir/$side/replay-verify.log"

  local wsload_status="NA"
  local peak="NA"
  local connect_fail="NA"
  local closed_early="NA"
  local ack_p95="NA"
  local broadcast_p95="NA"
  local seq_gap="NA"
  local backpressure="NA"
  local replay_ok="0"

  if [[ -f "$summary" ]]; then
    wsload_status="$(env_value wsload_status "$summary")"
    [[ -n "$wsload_status" ]] || wsload_status="NA"
  fi
  if [[ -f "$log" ]]; then
    peak="$(log_number 's/.*peak concurrent[[:space:]]*:[[:space:]]*([0-9,]+).*/\1/p' "$log")"
    connect_fail="$(log_number 's/.*FAIL[[:space:]]+([0-9,]+).*/\1/p' "$log")"
    closed_early="$(log_number 's/.*closed[- ]early[[:space:]]+([0-9,]+).*/\1/p' "$log")"
    [[ -n "$peak" ]] || peak="NA"
    [[ -n "$connect_fail" ]] || connect_fail="NA"
    [[ -n "$closed_early" ]] || closed_early="NA"
  fi
  if [[ -f "$metrics" ]]; then
    ack_p95="$(num_or_empty '.ackLatencyMs.p95 // .ackLatencyMs.p95Ms // .ack.p95 // .ack.p95_ms // .server.ackP95Ms // .server.ack_p95_ms // .lumen.bidAckP95Ms // .lumen_bid_ack_latency_ms_p95' "$metrics")"
    broadcast_p95="$(num_or_empty '.broadcastLatencyMs.p95 // .broadcastLatencyMs.p95Ms // .broadcast.p95 // .broadcast.p95_ms // .bcast.p95 // .server.broadcastP95Ms // .server.broadcast_p95_ms // .lumen.broadcastP95Ms // .lumen_broadcast_latency_ms_p95' "$metrics")"
    seq_gap="$(num_or_empty '.seqGapCount // .sequenceGapCount // .eventSeqGaps // .server.seqGapCount // .lumen.sequenceGapCount // .lumen_sequence_gap_count' "$metrics")"
    backpressure="$(num_or_empty '.backpressureForceClose // .backpressure_force_close // .ws.backpressureForceClose // .server.backpressureForceClose // .lumen.backpressureForceClose // .lumen_backpressure_force_close_total' "$metrics")"
    [[ -n "$ack_p95" ]] || ack_p95="NA"
    [[ -n "$broadcast_p95" ]] || broadcast_p95="NA"
    [[ -n "$seq_gap" ]] || seq_gap="NA"
    [[ -n "$backpressure" ]] || backpressure="NA"
  fi
  if [[ -f "$replay" ]]; then
    replay_ok="$(replay_consistent "$replay")"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$side" "$wsload_status" "$peak" "$connect_fail" "$closed_early" "$ack_p95" "$broadcast_p95" "$seq_gap" "$backpressure" "$replay_ok" >> "$metrics_tsv"
}

collect_side base
collect_side head

metric_value() {
  local side="$1"
  local col="$2"
  awk -F '\t' -v side="$side" -v col="$col" '
    NR == 1 {
      for (i = 1; i <= NF; i++) if ($i == col) idx = i
      next
    }
    $1 == side { print $idx; exit }
  ' "$metrics_tsv"
}

head_wsload_status="$(metric_value head wsload_status)"
base_wsload_status="$(metric_value base wsload_status)"
head_peak="$(metric_value head peak_concurrent)"
base_peak="$(metric_value base peak_concurrent)"
head_connect_fail="$(metric_value head connect_fail)"
head_closed_early="$(metric_value head closed_early)"
head_ack_p95="$(metric_value head ack_p95_ms)"
base_ack_p95="$(metric_value base ack_p95_ms)"
head_broadcast_p95="$(metric_value head broadcast_p95_ms)"
base_broadcast_p95="$(metric_value base broadcast_p95_ms)"
head_seq_gap="$(metric_value head seq_gap_count)"
head_backpressure="$(metric_value head backpressure_force_close)"
head_replay_ok="$(metric_value head replay_consistent)"

if [[ "$base_wsload_status" == "0" ]]; then
  record "base_wsload_exit" "PASS" "$base_wsload_status" "0" "base run exited cleanly"
else
  record "base_wsload_exit" "FAIL" "$base_wsload_status" "0" "base run did not exit cleanly"
fi

if [[ "$head_wsload_status" == "0" ]]; then
  record "head_wsload_exit" "PASS" "$head_wsload_status" "0" "head run exited cleanly"
else
  record "head_wsload_exit" "FAIL" "$head_wsload_status" "0" "head run did not exit cleanly"
fi

if [[ "$head_connect_fail" != "NA" ]] && cmp_eq_zero "$head_connect_fail"; then
  record "head_connect_fail" "PASS" "$head_connect_fail" "0" "no head connect failures"
else
  record "head_connect_fail" "FAIL" "$head_connect_fail" "0" "head connect failures present or unparseable"
fi

if [[ "$head_closed_early" != "NA" ]] && cmp_eq_zero "$head_closed_early"; then
  record "head_closed_early" "PASS" "$head_closed_early" "0" "no head early closes"
else
  record "head_closed_early" "FAIL" "$head_closed_early" "0" "head early closes present or unparseable"
fi

if [[ "$head_seq_gap" != "NA" ]] && cmp_eq_zero "$head_seq_gap"; then
  record "head_seq_gap_count" "PASS" "$head_seq_gap" "0" "no head sequence gaps"
else
  record "head_seq_gap_count" "FAIL" "$head_seq_gap" "0" "head sequence gaps present or unparseable"
fi

if [[ "$head_backpressure" != "NA" ]] && cmp_eq_zero "$head_backpressure"; then
  record "head_backpressure_force_close" "PASS" "$head_backpressure" "0" "no head backpressure force closes"
else
  record "head_backpressure_force_close" "FAIL" "$head_backpressure" "0" "head backpressure force closes present or unparseable"
fi

if [[ "$head_replay_ok" == "1" ]]; then
  record "head_replay_consistent" "PASS" "$head_replay_ok" "1" "replay verifier reported consistent"
else
  record "head_replay_consistent" "FAIL" "$head_replay_ok" "1" "replay verifier did not report consistent"
fi

if [[ "$head_ack_p95" != "NA" ]] && cmp_le "$head_ack_p95" "$ACK_P95_MAX_MS"; then
  record "head_ack_p95_absolute" "PASS" "$head_ack_p95" "<= $ACK_P95_MAX_MS" "head ack p95 within SLO"
else
  record "head_ack_p95_absolute" "FAIL" "$head_ack_p95" "<= $ACK_P95_MAX_MS" "head ack p95 missing or above SLO"
fi

if [[ "$head_broadcast_p95" != "NA" ]] && cmp_le "$head_broadcast_p95" "$BROADCAST_P95_MAX_MS"; then
  record "head_broadcast_p95_absolute" "PASS" "$head_broadcast_p95" "<= $BROADCAST_P95_MAX_MS" "head broadcast p95 within SLO"
else
  record "head_broadcast_p95_absolute" "FAIL" "$head_broadcast_p95" "<= $BROADCAST_P95_MAX_MS" "head broadcast p95 missing or above SLO"
fi

if [[ "$base_ack_p95" != "NA" && "$head_ack_p95" != "NA" ]]; then
  ack_limit="$(awk -v base="$base_ack_p95" -v pct="$ACK_P95_REGRESSION_PCT" 'BEGIN { printf "%.6f", base * (1 + pct / 100) }')"
  if cmp_le "$head_ack_p95" "$ack_limit"; then
    record "head_ack_p95_regression" "PASS" "$head_ack_p95" "<= $ack_limit" "head ack p95 within ${ACK_P95_REGRESSION_PCT}% of base"
  else
    record "head_ack_p95_regression" "FAIL" "$head_ack_p95" "<= $ack_limit" "head ack p95 regressed beyond ${ACK_P95_REGRESSION_PCT}%"
  fi
else
  record "head_ack_p95_regression" "FAIL" "base=$base_ack_p95 head=$head_ack_p95" "parseable metrics" "missing ack comparison metrics"
fi

if [[ "$base_broadcast_p95" != "NA" && "$head_broadcast_p95" != "NA" ]]; then
  broadcast_limit="$(awk -v base="$base_broadcast_p95" -v pct="$BROADCAST_P95_REGRESSION_PCT" 'BEGIN { printf "%.6f", base * (1 + pct / 100) }')"
  if cmp_le "$head_broadcast_p95" "$broadcast_limit"; then
    record "head_broadcast_p95_regression" "PASS" "$head_broadcast_p95" "<= $broadcast_limit" "head broadcast p95 within ${BROADCAST_P95_REGRESSION_PCT}% of base"
  else
    record "head_broadcast_p95_regression" "FAIL" "$head_broadcast_p95" "<= $broadcast_limit" "head broadcast p95 regressed beyond ${BROADCAST_P95_REGRESSION_PCT}%"
  fi
else
  record "head_broadcast_p95_regression" "FAIL" "base=$base_broadcast_p95 head=$head_broadcast_p95" "parseable metrics" "missing broadcast comparison metrics"
fi

if [[ "$base_peak" != "NA" && "$head_peak" != "NA" ]]; then
  peak_min="$(awk -v base="$base_peak" -v ratio="$PEAK_CONN_MIN_RATIO" 'BEGIN { printf "%.0f", base * ratio }')"
  if cmp_ge "$head_peak" "$peak_min"; then
    record "head_peak_concurrent" "PASS" "$head_peak" ">= $peak_min" "head reached comparable peak concurrency"
  else
    record "head_peak_concurrent" "FAIL" "$head_peak" ">= $peak_min" "head did not reach comparable peak concurrency"
  fi
else
  record "head_peak_concurrent" "FAIL" "base=$base_peak head=$head_peak" "parseable logs" "missing peak concurrency comparison"
fi

result="PASS"
if [[ "$failures" -gt 0 ]]; then
  result="FAIL"
fi

cat > "$summary_md" <<EOF_SUMMARY
# wsload compare gate

- result: $result
- compare_dir: $compare_dir
- gate: $gate_tsv
- metrics: $metrics_tsv
- ack_p95_absolute_ms: <= $ACK_P95_MAX_MS
- broadcast_p95_absolute_ms: <= $BROADCAST_P95_MAX_MS
- ack_p95_regression_pct: $ACK_P95_REGRESSION_PCT
- broadcast_p95_regression_pct: $BROADCAST_P95_REGRESSION_PCT
- peak_conn_min_ratio: $PEAK_CONN_MIN_RATIO

## Boundary

This gate reviews artifacts from a completed compare run. It does not run load,
seed auctions, or prove 100k readiness. It is intended to decide whether the
#151 coalescing branch is comparable to #120 on the same load box before the
draft is marked ready.

## Metrics

\`\`\`tsv
$(cat "$metrics_tsv")
\`\`\`

## Gate

\`\`\`tsv
$(cat "$gate_tsv")
\`\`\`
EOF_SUMMARY

printf 'result=%s\nout_dir=%s\ngate=%s\nsummary=%s\nmetrics=%s\n' "$result" "$out_dir" "$gate_tsv" "$summary_md" "$metrics_tsv"

if [[ "$result" == "FAIL" ]]; then
  exit 1
fi
