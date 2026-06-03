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
  ACK_P95_MAX_MS=${ACK_P95_MAX_MS:-80}
  BROADCAST_P95_MAX_MS=${BROADCAST_P95_MAX_MS:-150}
  HAMMER_P95_MAX_MS=${HAMMER_P95_MAX_MS:-500}
  CATCHUP_P95_MAX_MS=${CATCHUP_P95_MAX_MS:-1000}
  REQUIRE_HAMMER=${REQUIRE_HAMMER:-1}
  REQUIRE_CATCHUP=${REQUIRE_CATCHUP:-1}
  REPORT_ONLY=${REPORT_ONLY:-0}
USAGE
  exit "$code"
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

add_check() {
  check_name="$1"
  required="$2"
  observed="$3"
  op="$4"
  threshold="$5"
  reason="ok"

  if [ -z "$observed" ]; then
    if [ "$required" = "1" ]; then
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
CLIENT_SUMMARY=""
OUT_DIR=""
TARGET_CONNS="${TARGET_CONNS:-500}"
ACK_P95_MAX_MS="${ACK_P95_MAX_MS:-80}"
BROADCAST_P95_MAX_MS="${BROADCAST_P95_MAX_MS:-150}"
HAMMER_P95_MAX_MS="${HAMMER_P95_MAX_MS:-500}"
CATCHUP_P95_MAX_MS="${CATCHUP_P95_MAX_MS:-1000}"
REQUIRE_HAMMER="${REQUIRE_HAMMER:-1}"
REQUIRE_CATCHUP="${REQUIRE_CATCHUP:-1}"
REPORT_ONLY="${REPORT_ONLY:-0}"

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

if [ "${TARGET_CONNS:-0}" = "0" ]; then
  add_check "server_active_conns" "0" "$ACTIVE_CONNS" ">=" "0"
else
  add_check "server_active_conns" "1" "$ACTIVE_CONNS" ">=" "$TARGET_CONNS"
fi
add_check "server_ack_p95_ms" "1" "$ACK_P95" "<=" "$ACK_P95_MAX_MS"
add_check "server_broadcast_p95_ms" "1" "$BROADCAST_P95" "<=" "$BROADCAST_P95_MAX_MS"
add_check "server_hammer_p95_ms" "$REQUIRE_HAMMER" "$HAMMER_P95" "<=" "$HAMMER_P95_MAX_MS"
add_check "server_catchup_p95_ms" "$REQUIRE_CATCHUP" "$CATCHUP_P95" "<=" "$CATCHUP_P95_MAX_MS"
add_check "server_seq_gap_count" "0" "$SEQ_GAPS" "==" "0"
add_check "server_backpressure_force_close" "0" "$BACKPRESSURE_CLOSES" "==" "0"

if [ -n "$CLIENT_SUMMARY" ]; then
  CLIENT_COPY="$OUT_DIR/client-summary.json"
  CLIENT_HTTP_P95=$(json_num '.metrics.http_req_duration.values["p(95)"] // .metrics.http_req_duration.percentiles.p95 // .http_req_duration.p95' "$CLIENT_COPY")
  CLIENT_ACK_P95=$(json_num '.metrics.ws_ack_rtt.values["p(95)"] // .metrics.bid_ack_rtt.values["p(95)"] // .metrics.ack_rtt.values["p(95)"] // .client.ackP95Ms // .client_ack_p95_ms' "$CLIENT_COPY")
  CLIENT_BROADCAST_P95=$(json_num '.metrics.ws_broadcast_lag.values["p(95)"] // .metrics.broadcast_lag.values["p(95)"] // .metrics.broadcast_rtt.values["p(95)"] // .client.broadcastP95Ms // .client_broadcast_p95_ms' "$CLIENT_COPY")
  CLIENT_CONN_P95=$(json_num '.metrics.ws_connecting.values["p(95)"] // .metrics.ws_session_duration.values["p(95)"] // .client.connectP95Ms // .client_connect_p95_ms' "$CLIENT_COPY")

  add_client_observed "client_http_req_duration_p95_ms" "$CLIENT_HTTP_P95" "observed_only_not_server_slo"
  add_client_observed "client_ack_rtt_p95_ms" "$CLIENT_ACK_P95" "observed_only_not_server_slo"
  add_client_observed "client_broadcast_lag_p95_ms" "$CLIENT_BROADCAST_P95" "observed_only_not_server_slo"
  add_client_observed "client_connect_or_session_p95_ms" "$CLIENT_CONN_P95" "observed_only_not_server_slo"
fi

if [ "$FAILS" -eq 0 ]; then
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
  echo "Server-side rows in gate.tsv are the only pass/fail SLO gates. Client and end-to-end metrics are retained as observed evidence only because WAN, browser, proxy, and runner delays are outside the backend SLO boundary."
  echo
  echo "## Thresholds"
  echo
  echo "- ack_p95_ms <= $ACK_P95_MAX_MS"
  echo "- broadcast_p95_ms <= $BROADCAST_P95_MAX_MS"
  echo "- hammer_p95_ms <= $HAMMER_P95_MAX_MS when REQUIRE_HAMMER=$REQUIRE_HAMMER"
  echo "- catchup_p95_ms <= $CATCHUP_P95_MAX_MS when REQUIRE_CATCHUP=$REQUIRE_CATCHUP"
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

if [ "$RESULT" = "FAIL" ] && [ "$REPORT_ONLY" != "1" ]; then
  exit 1
fi
