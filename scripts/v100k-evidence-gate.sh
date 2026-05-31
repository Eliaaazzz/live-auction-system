#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/v100k-evidence-gate.sh --metrics metrics.json --shards shards.tsv [--out-dir DIR]

Purpose:
  Gate a distributed 100k WebSocket capacity run using no-secret artifacts.
  The script creates an evidence pack under /tmp and exits non-zero unless the
  server metrics and load-worker shard summary meet the v100k pass bar.

Required inputs:
  --metrics FILE   JSON captured from the server /metrics endpoint during the
                   steady-state hold window.
  --shards FILE    TSV/CSV/space-delimited worker summary with columns:
                   worker target_conns connect_ok connect_fail closed_early
                   Header row is expected and skipped.

Optional inputs:
  --out-dir DIR    Evidence output directory.
  --target N       Required active connections. Default: 100000.

Environment overrides:
  ACK_P95_MAX_MS=80
  BROADCAST_P95_MAX_MS=150
  CONNECT_FAIL_RATE_MAX=0.001
  REQUIRE_SHARDS=1
  REPORT_ONLY=0        Set to 1 to write FAIL evidence but exit 0.

Accepted /metrics field names:
  activeConns, ackLatencyMs.p95, broadcastLatencyMs.p95, seqGapCount,
  backpressureForceClose. A few snake_case and short aliases are also accepted.
USAGE
}

metrics_json=""
shards_tsv=""
out_dir=""
TARGET_CONNS="${TARGET_CONNS:-100000}"
ACK_P95_MAX_MS="${ACK_P95_MAX_MS:-80}"
BROADCAST_P95_MAX_MS="${BROADCAST_P95_MAX_MS:-150}"
CONNECT_FAIL_RATE_MAX="${CONNECT_FAIL_RATE_MAX:-0.001}"
REQUIRE_SHARDS="${REQUIRE_SHARDS:-1}"
REPORT_ONLY="${REPORT_ONLY:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --metrics)
      metrics_json="${2:-}"
      shift 2
      ;;
    --shards)
      shards_tsv="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    --target)
      TARGET_CONNS="${2:-}"
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

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to parse metrics JSON" >&2
  exit 2
fi
if [ -z "$metrics_json" ] || [ ! -f "$metrics_json" ]; then
  echo "--metrics must point to an existing JSON file" >&2
  usage >&2
  exit 2
fi
if [ "$REQUIRE_SHARDS" = "1" ] && { [ -z "$shards_tsv" ] || [ ! -f "$shards_tsv" ]; }; then
  echo "--shards is required for the full v100k gate (set REQUIRE_SHARDS=0 for server-only rehearsal)" >&2
  usage >&2
  exit 2
fi
if [ -n "$shards_tsv" ] && [ ! -f "$shards_tsv" ]; then
  echo "--shards file not found: $shards_tsv" >&2
  exit 2
fi

if [ -z "$out_dir" ]; then
  out_dir="/tmp/lumen-v100k-evidence-gate-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$out_dir"
cp "$metrics_json" "$out_dir/metrics.json"
if [ -n "$shards_tsv" ]; then
  cp "$shards_tsv" "$out_dir/shards.tsv"
fi

gate_tsv="$out_dir/gate.tsv"
summary_md="$out_dir/summary.md"
fail_count=0

json_number() {
  jq -er "$1 | numbers" "$metrics_json" 2>/dev/null || true
}

cmp_number() {
  got="$1"
  op="$2"
  want="$3"
  case "$op" in
    ge) awk -v g="$got" -v w="$want" 'BEGIN { exit !((g + 0) >= (w + 0)) }' ;;
    gt) awk -v g="$got" -v w="$want" 'BEGIN { exit !((g + 0) >  (w + 0)) }' ;;
    le) awk -v g="$got" -v w="$want" 'BEGIN { exit !((g + 0) <= (w + 0)) }' ;;
    lt) awk -v g="$got" -v w="$want" 'BEGIN { exit !((g + 0) <  (w + 0)) }' ;;
    eq) awk -v g="$got" -v w="$want" 'BEGIN { exit !((g + 0) == (w + 0)) }' ;;
    *) return 2 ;;
  esac
}

record_check() {
  name="$1"
  got="$2"
  op="$3"
  want="$4"
  detail="$5"
  if [ -z "$got" ]; then
    status="FAIL"
    got="missing"
  elif cmp_number "$got" "$op" "$want"; then
    status="PASS"
  else
    status="FAIL"
  fi
  if [ "$status" = "FAIL" ]; then
    fail_count=$((fail_count + 1))
  fi
  printf '%s\t%s\t%s %s\t%s\t%s\n' "$name" "$got" "$op" "$want" "$status" "$detail" >> "$gate_tsv"
}

printf 'check\tgot\twant\tstatus\tdetail\n' > "$gate_tsv"

active_conns=$(json_number '.activeConns // .active_connections // .ws.activeConns')
ack_p95=$(json_number '.ackLatencyMs.p95 // .ackLatencyMs.p95Ms // .ackLatencyMs.P95 // .ack.p95 // .ack.p95_ms')
broadcast_p95=$(json_number '.broadcastLatencyMs.p95 // .broadcastLatencyMs.p95Ms // .broadcastLatencyMs.P95 // .broadcast.p95 // .broadcast.p95_ms // .bcast.p95')
seq_gap_count=$(json_number '.seqGapCount // .seq_gap_count // .seqGap // .seq_gap')
backpressure_force_close=$(json_number '.backpressureForceClose // .backpressure_force_close // .backpressureForceCloses // .backpressure')

record_check "server_active_conns" "$active_conns" ge "$TARGET_CONNS" "server /metrics must prove the target was actually held"
record_check "server_ack_p95_ms" "$ack_p95" lt "$ACK_P95_MAX_MS" "server-side ack latency is the SLO gate, not client RTT"
record_check "server_broadcast_p95_ms" "$broadcast_p95" lt "$BROADCAST_P95_MAX_MS" "single-room fanout must stay inside the broadcast SLO"
record_check "server_seq_gap_count" "$seq_gap_count" eq 0 "sequenced WS stream must not skip events"
record_check "server_backpressure_force_close" "$backpressure_force_close" eq 0 "steady-state proof must not trim slow clients"

if [ -n "$shards_tsv" ]; then
  shard_values=$(awk '
    BEGIN { FS = "[,	 ]+" }
    NR == 1 { next }
    NF >= 5 {
      target += $2
      ok += $3
      fail += $4
      early += $5
    }
    END { printf "%.0f %.0f %.0f %.0f", target, ok, fail, early }
  ' "$shards_tsv")
  set -- $shard_values
  shard_target="${1:-0}"
  shard_ok="${2:-0}"
  shard_fail="${3:-0}"
  shard_early="${4:-0}"
  shard_attempts=$(awk -v ok="$shard_ok" -v fail="$shard_fail" 'BEGIN { printf "%.0f", ok + fail }')
  if [ "$shard_attempts" = "0" ]; then
    connect_fail_rate="1"
  else
    connect_fail_rate=$(awk -v fail="$shard_fail" -v attempts="$shard_attempts" 'BEGIN { printf "%.6f", fail / attempts }')
  fi
  record_check "shard_target_conns" "$shard_target" ge "$TARGET_CONNS" "load workers must attempt the claimed capacity"
  record_check "shard_connect_failure_rate" "$connect_fail_rate" le "$CONNECT_FAIL_RATE_MAX" "aggregate connect failures must stay below the allowed rate"
  record_check "shard_closed_early" "$shard_early" eq 0 "steady-state clients must not close early after ramp"
else
  if [ "$REQUIRE_SHARDS" = "1" ]; then
    record_check "shard_summary_present" "" eq 1 "required worker summary is missing"
  else
    printf '%s\t%s\t%s\t%s\t%s\n' "shard_summary_present" "missing" "optional" "SKIP" "server-only rehearsal mode" >> "$gate_tsv"
  fi
fi

if [ "$fail_count" -eq 0 ]; then
  result="PASS"
else
  result="FAIL"
fi

cat > "$summary_md" <<EOF_SUMMARY
# Lumen v100k evidence gate

Result: $result

- target_conns: $TARGET_CONNS
- metrics_json: $metrics_json
- shards_tsv: ${shards_tsv:-not provided}
- evidence_dir: $out_dir
- ack_p95_max_ms: $ACK_P95_MAX_MS
- broadcast_p95_max_ms: $BROADCAST_P95_MAX_MS
- connect_fail_rate_max: $CONNECT_FAIL_RATE_MAX

If this result is FAIL, the honest external claim is: 10k verified; 100k not yet verified. Name the failed check before rerunning.

See gate.tsv for machine-readable checks.
EOF_SUMMARY

printf 'result=%s\nevidence_dir=%s\nsummary=%s\ngate=%s\n' "$result" "$out_dir" "$summary_md" "$gate_tsv"

if [ "$result" != "PASS" ] && [ "$REPORT_ONLY" != "1" ]; then
  exit 1
fi
