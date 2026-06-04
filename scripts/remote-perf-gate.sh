#!/bin/sh
set -eu

usage() {
  code="${1:-2}"
  cat >&2 <<USAGE
Usage: $0 --server-metrics metrics.json [--client-summary k6-summary.json] [--target N] [--out-dir DIR]

Creates a no-secret remote perf evidence pack and gates only server-side SLOs.
End-to-end/client latency is copied and summarized as observed evidence, not as a
hard server SLO, because WAN, browser, proxy, and client runtime delays are not
owned by the auction backend.

Environment thresholds:
  TARGET_CONNS=${TARGET_CONNS:-500}
  CLIENT_SUMMARY=${CLIENT_SUMMARY:-${PERF_GATE_CLIENT_SUMMARY:-}}
    (or PERF_GATE_CLIENT_SUMMARY, kept for Makefile compatibility)
  ACK_P95_MAX_MS=${ACK_P95_MAX_MS:-80}
  BROADCAST_P95_MAX_MS=${BROADCAST_P95_MAX_MS:-150}
  HAMMER_P95_MAX_MS=${HAMMER_P95_MAX_MS:-500}
  CATCHUP_P95_MAX_MS=${CATCHUP_P95_MAX_MS:-1000}
  CLIENT_CONNECT_FAIL_RATE_MAX_PCT=${CLIENT_CONNECT_FAIL_RATE_MAX_PCT:-}
  REQUIRE_HAMMER=${REQUIRE_HAMMER:-1}
  REQUIRE_CATCHUP=${REQUIRE_CATCHUP:-1}
  ROOM_STATE_PATCH_MIN_EMITTED=${ROOM_STATE_PATCH_MIN_EMITTED:-0}
  ROOM_STATE_PATCH_MIN_BIDS=${ROOM_STATE_PATCH_MIN_BIDS:-0}
  # When set to 1/true/yes/on, checks are still evaluated and reported but non-zero exit is
  # suppressed so this becomes an evidence-only dry run.
  REPORT_ONLY=${REPORT_ONLY:-0}
USAGE
  exit "$code"
}

is_true() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)" in
    1|true|yes|on)
      echo 1
      ;;
    0|false|no|off)
      echo 0
      ;;
    *)
      echo "error: invalid boolean value '$1'; expected 0/1/true/false/yes/no/on/off" >&2
      exit 2
      ;;
  esac
}

die() {
  echo "error: $*" >&2
  exit 2
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

json_num() {
  filter="$1"
  file="$2"
  jq -er "$filter | if type == \"number\" then . elif type == \"string\" then tonumber? else empty end" "$file" 2>/dev/null || true
}

compare_ok() {
  observed="$1"
  op="$2"
  threshold="$3"
  awk -v observed="$observed" -v threshold="$threshold" -v op="$op" '
    BEGIN {
      if (observed == "" || threshold == "") exit 1
      if (op == "<=") exit(observed + 0 <= threshold + 0 ? 0 : 1)
      if (op == ">=") exit(observed + 0 >= threshold + 0 ? 0 : 1)
      if (op == "==") exit(observed + 0 == threshold + 0 ? 0 : 1)
      exit 1
    }
  '
}

is_non_negative_int() {
  case "$1" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
    esac
}

is_non_negative_number() {
  awk -v v="$1" 'BEGIN {
    if (v == "") exit 1
    if (v ~ /^([0-9]+([.][0-9]*)?|[.][0-9]+)$/) exit 0
    exit 1
  }'
}

add_check() {
  check_name="$1"
  required="$2"
  observed="$3"
  op="$4"
  threshold="$5"
  reason="ok"

  if [ -z "$observed" ]; then
    if is_true "$required"; then
      status="FAIL"
      reason="missing_required_metric"
      FAILS=$((FAILS + 1))
    else
      status="SKIP"
      reason="metric_not_provided"
    fi
  elif compare_ok "$observed" "$op" "$threshold"; then
    status="PASS"
  else
    status="FAIL"
    reason="threshold_breach"
    FAILS=$((FAILS + 1))
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$check_name" "$status" "${observed:-NA}" "$op" "$threshold" "$reason" >> "$GATE_TSV"
}

compute_connect_fail_rate_pct() {
  attempts="$1"
  failures="$2"

  if [ -z "$attempts" ] || [ -z "$failures" ]; then
    return 1
  fi

  awk -v attempts="$attempts" -v failures="$failures" '
    BEGIN {
      if (attempts == 0) exit 1
      printf "%.10f", (failures / attempts) * 100.0
    }
  '
}

add_client_observed() {
  metric_name="$1"
  observed="$2"
  note="$3"
  if [ -n "$observed" ]; then
    printf '%s\t%s\t%s\n' "$metric_name" "$observed" "$note" >> "$CLIENT_TSV"
    CLIENT_ROWS=$((CLIENT_ROWS + 1))
  fi
}

SERVER_METRICS=""
CLIENT_SUMMARY="${CLIENT_SUMMARY:-${PERF_GATE_CLIENT_SUMMARY:-}}"
OUT_DIR=""
TARGET_CONNS="${TARGET_CONNS:-500}"
ACK_P95_MAX_MS="${ACK_P95_MAX_MS:-80}"
BROADCAST_P95_MAX_MS="${BROADCAST_P95_MAX_MS:-150}"
HAMMER_P95_MAX_MS="${HAMMER_P95_MAX_MS:-500}"
CATCHUP_P95_MAX_MS="${CATCHUP_P95_MAX_MS:-1000}"
CLIENT_CONNECT_FAIL_RATE_MAX_PCT="${CLIENT_CONNECT_FAIL_RATE_MAX_PCT:-}"
REQUIRE_HAMMER="${REQUIRE_HAMMER:-1}"
REQUIRE_CATCHUP="${REQUIRE_CATCHUP:-1}"
ROOM_STATE_PATCH_MIN_EMITTED="${ROOM_STATE_PATCH_MIN_EMITTED:-0}"
ROOM_STATE_PATCH_MIN_BIDS="${ROOM_STATE_PATCH_MIN_BIDS:-0}"
REPORT_ONLY="${REPORT_ONLY:-0}"
REPORT_ONLY="$(normalize_bool "$REPORT_ONLY")"
REQUIRE_HAMMER="$(normalize_bool "$REQUIRE_HAMMER")"
REQUIRE_CATCHUP="$(normalize_bool "$REQUIRE_CATCHUP")"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server-metrics)
      [ "$#" -ge 2 ] || usage
      SERVER_METRICS="$2"
      shift 2
      ;;
    --client-summary)
      [ "$#" -ge 2 ] || usage
      CLIENT_SUMMARY="$2"
      shift 2
      ;;
    --out-dir)
      [ "$#" -ge 2 ] || usage
      OUT_DIR="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || usage
      TARGET_CONNS="$2"
      shift 2
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      ;;
  esac
done

if ! is_non_negative_int "$ACK_P95_MAX_MS"; then
  die "ACK_P95_MAX_MS must be a non-negative integer"
fi
if ! is_non_negative_int "$BROADCAST_P95_MAX_MS"; then
  die "BROADCAST_P95_MAX_MS must be a non-negative integer"
fi
if ! is_non_negative_int "$HAMMER_P95_MAX_MS"; then
  die "HAMMER_P95_MAX_MS must be a non-negative integer"
fi
if ! is_non_negative_int "$CATCHUP_P95_MAX_MS"; then
  die "CATCHUP_P95_MAX_MS must be a non-negative integer"
fi
if [ -n "$CLIENT_CONNECT_FAIL_RATE_MAX_PCT" ] && ! is_non_negative_number "$CLIENT_CONNECT_FAIL_RATE_MAX_PCT"; then
  die "CLIENT_CONNECT_FAIL_RATE_MAX_PCT must be a non-negative number"
fi
if ! is_non_negative_int "$TARGET_CONNS"; then
  die "TARGET_CONNS must be a non-negative integer"
fi
if ! is_non_negative_int "$ROOM_STATE_PATCH_MIN_EMITTED"; then
  die "ROOM_STATE_PATCH_MIN_EMITTED must be a non-negative integer"
fi
if ! is_non_negative_int "$ROOM_STATE_PATCH_MIN_BIDS"; then
  die "ROOM_STATE_PATCH_MIN_BIDS must be a non-negative integer"
fi

[ -n "$SERVER_METRICS" ] || usage
[ -r "$SERVER_METRICS" ] || die "cannot read --server-metrics: $SERVER_METRICS"
if [ -n "$CLIENT_SUMMARY" ]; then
  [ -r "$CLIENT_SUMMARY" ] || die "cannot read --client-summary: $CLIENT_SUMMARY"
fi

need_cmd jq
need_cmd awk

if [ -z "$OUT_DIR" ]; then
  OUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lumen-remote-perf-gate-XXXXXX")
else
  mkdir -p "$OUT_DIR"
fi

SERVER_COPY="$OUT_DIR/server-metrics.json"
GATE_TSV="$OUT_DIR/gate.tsv"
SUMMARY_MD="$OUT_DIR/summary.md"
CLIENT_TSV="$OUT_DIR/client-observed.tsv"
cp "$SERVER_METRICS" "$SERVER_COPY"
if [ -n "$CLIENT_SUMMARY" ]; then
  cp "$CLIENT_SUMMARY" "$OUT_DIR/client-summary.json"
fi

if ! jq -e 'type == "object"' "$SERVER_COPY" >/dev/null 2>&1; then
  echo "error: ${SERVER_COPY} is not a valid JSON object (expected lumen /metrics snapshot)"
  exit 1
fi

printf 'check\tstatus\tobserved\top\tthreshold\treason\n' > "$GATE_TSV"
printf 'metric\tobserved_ms\tnote\n' > "$CLIENT_TSV"
FAILS=0
CLIENT_ROWS=0

ACTIVE_CONNS=$(json_num '.activeConns // .active_connections // .connections.active // .ws.activeConns // .ws.active_connections // .lumen.activeConns // .lumen_ws_active_connections' "$SERVER_COPY")
ACK_P95=$(json_num '.ackLatencyMs.p95 // .ackLatencyMs.p95Ms // .ackLatencyMs.P95 // .ack.p95 // .ack.p95_ms // .server.ackP95Ms // .server.ack_p95_ms // .lumen.bidAckP95Ms // .lumen_bid_ack_latency_ms_p95' "$SERVER_COPY")
BROADCAST_P95=$(json_num '.broadcastLatencyMs.p95 // .broadcastLatencyMs.p95Ms // .broadcastLatencyMs.P95 // .broadcast.p95 // .broadcast.p95_ms // .bcast.p95 // .server.broadcastP95Ms // .server.broadcast_p95_ms // .lumen.broadcastP95Ms // .lumen_broadcast_latency_ms_p95' "$SERVER_COPY")
HAMMER_P95=$(json_num '.hammerLatencyMs.p95 // .hammerLatencyMs.p95Ms // .hammer.p95 // .hammer.p95_ms // .server.hammerP95Ms // .server.hammer_p95_ms // .lumen.hammerP95Ms // .lumen_hammer_latency_ms_p95' "$SERVER_COPY")
CATCHUP_P95=$(json_num '.catchupLatencyMs.p95 // .catchupLatencyMs.p95Ms // .catchup.p95 // .catchup.p95_ms // .catchup200Ms.p95 // .server.catchupP95Ms // .server.catchup_p95_ms // .lumen.catchupP95Ms // .lumen_catchup_latency_ms_p95' "$SERVER_COPY")
SEQ_GAPS=$(json_num '.seqGapCount // .sequenceGapCount // .eventSeqGaps // .server.seqGapCount // .lumen.sequenceGapCount // .lumen_sequence_gap_count' "$SERVER_COPY")
BACKPRESSURE_CLOSES=$(json_num '.backpressureForceClose // .backpressure_force_close // .ws.backpressureForceClose // .server.backpressureForceClose // .lumen.backpressureForceClose // .lumen_backpressure_force_close_total' "$SERVER_COPY")
ROOM_PATCH_EMITTED=$(json_num '.roomStatePatchEmitted // .room_state_patch_emitted // .roomStatePatch' "$SERVER_COPY")
ROOM_PATCH_BIDS=$(json_num '.roomStatePatchBids // .room_state_patch_bids // .roomStatePatchBids' "$SERVER_COPY")

if [ "${TARGET_CONNS:-0}" = "0" ]; then
  add_check "server_active_conns" "0" "$ACTIVE_CONNS" ">=" "0"
else
  add_check "server_active_conns" "1" "$ACTIVE_CONNS" ">=" "$TARGET_CONNS"
fi
add_check "server_ack_p95_ms" "1" "$ACK_P95" "<=" "$ACK_P95_MAX_MS"
add_check "server_broadcast_p95_ms" "1" "$BROADCAST_P95" "<=" "$BROADCAST_P95_MAX_MS"
add_check "server_hammer_p95_ms" "$REQUIRE_HAMMER" "$HAMMER_P95" "<=" "$HAMMER_P95_MAX_MS"
add_check "server_catchup_p95_ms" "$REQUIRE_CATCHUP" "$CATCHUP_P95" "<=" "$CATCHUP_P95_MAX_MS"
add_check "server_seq_gap_count" "1" "$SEQ_GAPS" "==" "0"
add_check "server_backpressure_force_close" "0" "$BACKPRESSURE_CLOSES" "==" "0"
add_check "server_room_state_patch_emitted" "$([ "$ROOM_STATE_PATCH_MIN_EMITTED" -gt 0 ] && echo 1 || echo 0)" "$ROOM_PATCH_EMITTED" ">=" "$ROOM_STATE_PATCH_MIN_EMITTED"
add_check "server_room_state_patch_bids" "$([ "$ROOM_STATE_PATCH_MIN_BIDS" -gt 0 ] && echo 1 || echo 0)" "$ROOM_PATCH_BIDS" ">=" "$ROOM_STATE_PATCH_MIN_BIDS"

if [ -n "$CLIENT_SUMMARY" ]; then
  CLIENT_COPY="$OUT_DIR/client-summary.json"
  CLIENT_HTTP_P95=$(json_num '.metrics.http_req_duration.values["p(95)"] // .metrics.http_req_duration.percentiles.p95 // .http_req_duration.p95' "$CLIENT_COPY")
  CLIENT_ACK_P95=$(json_num '.metrics.ws_ack_rtt.values["p(95)"] // .metrics.bid_ack_rtt.values["p(95)"] // .metrics.ack_rtt.values["p(95)"] // .client.ackP95Ms // .client_ack_p95_ms' "$CLIENT_COPY")
  CLIENT_BROADCAST_P95=$(json_num '.metrics.ws_broadcast_lag.values["p(95)"] // .metrics.broadcast_lag.values["p(95)"] // .metrics.broadcast_rtt.values["p(95)"] // .client.broadcastP95Ms // .client_broadcast_p95_ms' "$CLIENT_COPY")
  CLIENT_CONN_P95=$(json_num '.metrics.ws_connecting.values["p(95)"] // .metrics.ws_session_duration.values["p(95)"] // .client.connectP95Ms // .client_connect_p95_ms' "$CLIENT_COPY")
  CLIENT_CONNECT_FAIL_RATE_PCT=$(json_num '.connectFailRatePct // .connectFailureRatePct // .connect_fail_rate_pct // .connectFailPercent // .connectFailurePercent // .connect.failureRate // .connect.failurePct // .client.connectFailureRate // .client.connectFailurePercent // .client.connect_fail_rate_pct // .client.connectFailurePct // .stats.connect_failure_rate // .metrics.connectFailureRatePct // .metrics.connectFailRate // .metrics.ws_connect_fail_rate_pct // .metrics.connect_fail_rate_pct' "$CLIENT_COPY")

  if [ -z "$CLIENT_CONNECT_FAIL_RATE_PCT" ]; then
    CLIENT_CONNECT_ATTEMPTS=$(json_num '.connect.attempts // .connectAttempts // .connect.count // .connect.total // .client.connectAttempts // .client.connectCount // .stats.connect_attempts // .totals.connectAttempts // .metrics.connect_attempts' "$CLIENT_COPY")
    CLIENT_CONNECT_FAILURES=$(json_num '.connect.failures // .connect.fails // .connect.failureCount // .connect.failed // .client.connectFailures // .client.connectFails // .stats.connect_failures // .totals.connectFailures // .metrics.connect_failures' "$CLIENT_COPY")
    CLIENT_CONNECT_FAIL_RATE_PCT=$(compute_connect_fail_rate_pct "$CLIENT_CONNECT_ATTEMPTS" "$CLIENT_CONNECT_FAILURES")
  fi

  add_client_observed "client_http_req_duration_p95_ms" "$CLIENT_HTTP_P95" "observed_only_not_server_slo"
  add_client_observed "client_ack_rtt_p95_ms" "$CLIENT_ACK_P95" "observed_only_not_server_slo"
  add_client_observed "client_broadcast_lag_p95_ms" "$CLIENT_BROADCAST_P95" "observed_only_not_server_slo"
  add_client_observed "client_connect_or_session_p95_ms" "$CLIENT_CONN_P95" "observed_only_not_server_slo"
  add_client_observed "client_connect_failure_rate_pct" "$CLIENT_CONNECT_FAIL_RATE_PCT" "observed_only_not_server_slo"
fi

if [ -n "$CLIENT_CONNECT_FAIL_RATE_MAX_PCT" ]; then
  if [ -z "$CLIENT_SUMMARY" ]; then
    add_check "client_connect_failure_rate_pct" "1" "" "<=" "$CLIENT_CONNECT_FAIL_RATE_MAX_PCT"
  else
    add_check "client_connect_failure_rate_pct" "1" "$CLIENT_CONNECT_FAIL_RATE_PCT" "<=" "$CLIENT_CONNECT_FAIL_RATE_MAX_PCT"
  fi
fi

if is_true "$REPORT_ONLY" && [ "$FAILS" -ne 0 ]; then
  RESULT="FAIL-REPORTED"
elif [ "$FAILS" -eq 0 ]; then
  RESULT="PASS"
else
  RESULT="FAIL"
fi

{
  echo "# Remote perf evidence gate"
  echo
  echo "- result: $RESULT"
  echo "- generated_at_utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "- target_active_connections: $TARGET_CONNS"
  echo "- server_metrics: server-metrics.json"
  echo "- gate: gate.tsv"
  if [ -n "$CLIENT_SUMMARY" ]; then
    echo "- client_summary: client-summary.json"
    echo "- client_observed: client-observed.tsv"
  fi
  echo
  echo "## Measurement boundary"
  echo
  echo "Server-side rows in gate.tsv are the default pass/fail SLO gates. Client and end-to-end metrics are retained as observed evidence unless client-specific gates are explicitly enabled by client env vars, because WAN, browser, proxy, and runner delays are outside the backend SLO boundary."
  echo
  echo "## Thresholds"
  echo
  echo "- ack_p95_ms <= $ACK_P95_MAX_MS"
  echo "- broadcast_p95_ms <= $BROADCAST_P95_MAX_MS"
  echo "- hammer_p95_ms <= $HAMMER_P95_MAX_MS when REQUIRE_HAMMER=$REQUIRE_HAMMER"
  echo "- catchup_p95_ms <= $CATCHUP_P95_MAX_MS when REQUIRE_CATCHUP=$REQUIRE_CATCHUP"
  if [ -n "$CLIENT_CONNECT_FAIL_RATE_MAX_PCT" ]; then
    echo "- client_connect_failure_rate_pct <= $CLIENT_CONNECT_FAIL_RATE_MAX_PCT"
  fi
  echo "- roomStatePatchEmitted >= $ROOM_STATE_PATCH_MIN_EMITTED if set (>0)"
  echo "- roomStatePatchBids >= $ROOM_STATE_PATCH_MIN_BIDS if set (>0)"
  echo "- active_connections >= $TARGET_CONNS unless --target 0 is used"
  echo
  echo "## Server gate"
  echo
  echo '```tsv'
  cat "$GATE_TSV"
  echo '```'
  if [ -n "$CLIENT_SUMMARY" ]; then
    echo
    echo "## Client observed metrics"
    echo
    if [ "$CLIENT_ROWS" -eq 0 ]; then
      echo "No recognized client p95 metrics were found in client-summary.json."
    else
      echo '```tsv'
      cat "$CLIENT_TSV"
      echo '```'
    fi
  fi
} > "$SUMMARY_MD"

echo "result=$RESULT"
echo "evidence_dir=$OUT_DIR"
echo "summary=$SUMMARY_MD"
echo "gate=$GATE_TSV"

if [ "$RESULT" = "PASS" ] || [ "$RESULT" = "FAIL-REPORTED" ]; then
  exit 0
fi
exit 1
