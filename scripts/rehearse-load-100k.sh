#!/usr/bin/env bash
set -euo pipefail

# Super-stretch rehearsal helper for the non-P0 100k lane:
# - runs one or more `make load` invocations with fixed super-stretch defaults
# - captures per-run logs and metrics snapshots
# - writes a compact manifest + summary under a timestamped pack folder
#
# Usage:
#   scripts/rehearse-load-100k.sh --confirm [--attempts N] [options]

usage() {
  cat <<'EOF'
Usage:
  scripts/rehearse-load-100k.sh [options]

Environment:
  BASE_URL               Base URL for backend health/metrics endpoints (default: http://localhost:8080)
  BASE_WS_URL            WebSocket URL for catchup smoke (optional). If omitted, derived from BASE_URL.
  REQUIRE_WS_SCHEMA_CHECK Whether schema precheck should run during catchup smoke (1/true/yes/on).
  WS_PRECHECK_SCHEMA      Expected WS schema version for precheck (default: SCHEMA_VERSION or 1).
  WS_PRECHECK_TOKEN       WS token for schema precheck (optional).
  WS_PRECHECK_TIMEOUT_MS  Timeout for schema precheck in ms (default: 8000).
  WS_PRECHECK_AUCTION     WS precheck auction id override (optional).

Options:
  --confirm            required; explicit opt-in for non-P0 rehearsal
  --allow-low-ulimit   set LOAD_100K_ALLOW_LOW_ULIMIT=1 (or true/yes/on)
  --allow-low-ephemeral set LOAD_100K_ALLOW_LOW_EPHEMERAL=1 (or true/yes/on)
  --attempts N         number of load runs (default: 1)
  --interval SEC       sleep between attempts (default: 0)
  --label STR          label suffix for output directory (default: timestamp)
  --base-url URL       override BASE_URL for health/metrics checks
  --base-ws-url URL    override BASE_WS_URL for catchup smoke (base URL; pass https://... or wss://..., not .../ws)
  --pack-dir DIR       base output dir (default: .load-100k-rehearsals)
  --ws-precheck        run WS schema precheck for each attempt
  --ws-precheck-auction ID
  --ws-precheck-schema N
  --ws-precheck-token TOK
  --ws-precheck-timeout-ms N
  --up                 run `make up` before first attempt if health check fails
  --down               stop stack after all attempts finish
  --observers N        override LOAD_OBSERVERS (default: 100000)
  --bidders N          override LOAD_BIDDERS (default: 2000)
  --shards N           override LOAD_SHARDS (default: 4)
  --duration N         override LOAD_DURATION_SEC (default: 60)
  --auction-dur N      override LOAD_AUCTION_DUR_SEC (default: 3600)
  --bid-interval N     override LOAD_BID_INTERVAL_MS (default: 100)
  --auction-mode MODE   override LOAD_AUCTION_MODE (default: first_price if empty)
  --ack-p95 N          override LOAD_ACK_P95_MS (default: 800)
  --broadcast-p95 N    override LOAD_BROADCAST_P95_MS (default: 1000)
  --script-p99 N       override LOAD_SCRIPT_P99_MS (default: 20)
  --hammer-p95 N       override LOAD_HAMMER_P95_MS (default: 2000)
  --catchup-p95 N      override LOAD_CATCHUP_P95_MS (default: 3000)
  --observer-stagger N  override LOAD_OBSERVER_STAGGER_MS (default: 0)
  --min-peak-active-connections N
                       minimum observed max active connections across all runs
  --json               print manifest JSON to stdout at end
  --catchup-smoke      run ROOM_JOIN catchup smoke after each attempt
  -h, --help           show this help

Output:
  .load-100k-rehearsals/<label>/
    manifest.json
    summary.tsv
    runs/<run-id>/load.log
    runs/<run-id>/metrics.txt
    可选 runs/<run-id>/catchup.log、runs/<run-id>/ws-schema-precheck.log
EOF
}

ATTEMPTS=1
INTERVAL=0
CONFIRM="${CONFIRM:-0}"
OUTPUT_JSON="${OUTPUT_JSON:-0}"
RUN_CATCHUP_SMOKE="${RUN_CATCHUP_SMOKE:-0}"
RUN_WS_SCHEMA_PRECHECK="${RUN_WS_SCHEMA_PRECHECK:-${REQUIRE_WS_SCHEMA_CHECK:-0}}"
WS_PRECHECK_SCHEMA="${WS_PRECHECK_SCHEMA:-${SCHEMA_VERSION:-1}}"
WS_PRECHECK_TOKEN="${WS_PRECHECK_TOKEN:-${DEPLOY_REHEARSAL_WS_PRECHECK_TOKEN:-}}"
WS_PRECHECK_TIMEOUT_MS="${WS_PRECHECK_TIMEOUT_MS:-8000}"
WS_PRECHECK_AUCTION="${WS_PRECHECK_AUCTION:-}"
PACK_DIR_BASE=".load-100k-rehearsals"
PACK_LABEL=""
BASE_URL="${BASE_URL:-${TARGET_URL:-http://localhost:8080}}"
BASE_URL="${BASE_URL%/}"
BASE_WS_URL="${BASE_WS_URL:-}"
ENSURE_UP="${ENSURE_UP:-0}"
CLEANUP_STACK="${CLEANUP_STACK:-0}"
LOAD_100K_ALLOW_LOW_ULIMIT="${LOAD_100K_ALLOW_LOW_ULIMIT:-}"
LOAD_100K_ALLOW_LOW_EPHEMERAL="${LOAD_100K_ALLOW_LOW_EPHEMERAL:-}"
LOAD_OBSERVERS=100000
LOAD_BIDDERS=2000
LOAD_SHARDS=4
LOAD_DURATION_SEC=60
LOAD_AUCTION_DUR_SEC=3600
LOAD_AUCTION_MODE="${LOAD_AUCTION_MODE:-}"
LOAD_BID_INTERVAL_MS=100
LOAD_ACK_P95_MS=800
LOAD_BROADCAST_P95_MS=1000
LOAD_SCRIPT_P99_MS=20
LOAD_HAMMER_P95_MS=2000
LOAD_CATCHUP_P95_MS=3000
LOAD_OBSERVER_STAGGER_MS=0
MIN_PEAK_ACTIVE_CONNECTIONS="${MIN_PEAK_ACTIVE_CONNECTIONS:-0}"

POSITIONAL=()
SCRIPT_ARGS=("$@")
SCRIPT_COMMAND_LINE="$(printf '%q ' "$0" "${SCRIPT_ARGS[@]}")"
SCRIPT_COMMAND_LINE="${SCRIPT_COMMAND_LINE% }"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPT_GIT_HEAD="$(git -C "$SCRIPT_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"
SCRIPT_USER="${USER:-unknown}"
SCRIPT_HOST="$(hostname 2>/dev/null || echo unknown)"
SCRIPT_UTC_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

is_false() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)" in
    0|false|no|off)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

die() {
  echo "error: $*" >&2
  exit 2
}

normalize_auction_mode() {
  local mode="${1:-}"
  mode="$(printf '%s' "$mode" | tr '[:upper:]' '[:lower:]')"
  mode="$(printf '%s' "$mode" | xargs)"
  mode="${mode//-/_}"
  mode="$(printf '%s' "$mode" | tr -s '[:space:]' '_')"
  mode="$(printf '%s' "$mode" | tr -s '_')"
  mode="${mode##_}"
  mode="${mode%_}"
  case "$mode" in
    ""|"first"|"first_price"|"firstprice"|"english")
      echo "first_price"
      ;;
    "second"|"second_price"|"secondprice"|"vickrey")
      echo "second_price"
      ;;
    *)
      echo "$mode"
      ;;
  esac
}

is_supported_auction_mode() {
  case "$1" in
    first_price|second_price)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

as_bool01() {
  if is_true "$1"; then
    echo 1
    return
  fi
  if is_false "$1"; then
    echo 0
    return
  fi
  die "invalid boolean value '$1'; expected 0/1/true/false/yes/no/on/off"
}

is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-low-ulimit)
      LOAD_100K_ALLOW_LOW_ULIMIT=1
      shift
      ;;
    --allow-low-ephemeral)
      LOAD_100K_ALLOW_LOW_EPHEMERAL=1
      shift
      ;;
    --attempts)
      ATTEMPTS="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --confirm)
      CONFIRM=1
      shift
      ;;
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --label)
      PACK_LABEL="$2"
      shift 2
      ;;
    --pack-dir)
      PACK_DIR_BASE="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="$2"
      BASE_URL="${BASE_URL%/}"
      shift 2
      ;;
    --base-ws-url)
      BASE_WS_URL="$2"
      BASE_WS_URL="$(printf '%s' "$BASE_WS_URL" | xargs)"
      BASE_WS_URL="${BASE_WS_URL%/}"
      shift 2
      ;;
    --up)
      ENSURE_UP=1
      shift
      ;;
    --down)
      CLEANUP_STACK=1
      shift
      ;;
    --observers)
      LOAD_OBSERVERS="$2"
      shift 2
      ;;
    --bidders)
      LOAD_BIDDERS="$2"
      shift 2
      ;;
    --shards)
      LOAD_SHARDS="$2"
      shift 2
      ;;
    --duration)
      LOAD_DURATION_SEC="$2"
      shift 2
      ;;
    --auction-dur)
      LOAD_AUCTION_DUR_SEC="$2"
      shift 2
      ;;
    --auction-mode)
      LOAD_AUCTION_MODE="$2"
      shift 2
      ;;
    --bid-interval)
      LOAD_BID_INTERVAL_MS="$2"
      shift 2
      ;;
    --ack-p95)
      LOAD_ACK_P95_MS="$2"
      shift 2
      ;;
    --broadcast-p95)
      LOAD_BROADCAST_P95_MS="$2"
      shift 2
      ;;
    --script-p99)
      LOAD_SCRIPT_P99_MS="$2"
      shift 2
      ;;
    --hammer-p95)
      LOAD_HAMMER_P95_MS="$2"
      shift 2
      ;;
    --catchup-p95)
      LOAD_CATCHUP_P95_MS="$2"
      shift 2
      ;;
    --observer-stagger)
      LOAD_OBSERVER_STAGGER_MS="$2"
      shift 2
      ;;
    --min-peak-active-connections)
      MIN_PEAK_ACTIVE_CONNECTIONS="$2"
      shift 2
      ;;
    --catchup-smoke)
      RUN_CATCHUP_SMOKE=1
      shift
      ;;
    --ws-precheck)
      RUN_WS_SCHEMA_PRECHECK=1
      shift
      ;;
    --ws-precheck-auction)
      WS_PRECHECK_AUCTION="$2"
      shift 2
      ;;
    --ws-precheck-schema)
      WS_PRECHECK_SCHEMA="$2"
      shift 2
      ;;
    --ws-precheck-token)
      WS_PRECHECK_TOKEN="$2"
      shift 2
      ;;
    --ws-precheck-timeout-ms)
      WS_PRECHECK_TIMEOUT_MS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "unknown option: $1"
      usage
      exit 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ "${#POSITIONAL[@]}" -gt 0 ]]; then
  echo "unexpected arg: ${POSITIONAL[*]}"
  usage
  exit 2
fi

LOAD_AUCTION_MODE_NORMALIZED="$(normalize_auction_mode "${LOAD_AUCTION_MODE:-}")"
if [ -n "${LOAD_AUCTION_MODE:-}" ] && ! is_supported_auction_mode "$LOAD_AUCTION_MODE_NORMALIZED"; then
  echo "invalid --auction-mode '${LOAD_AUCTION_MODE}'."
  echo "supported: first_price (ENGLISH, first, firstprice, first price, english), second_price (second, secondprice, second price, vickrey, VICKREY)."
  exit 2
fi

CONFIRM="$(as_bool01 "$CONFIRM")"
OUTPUT_JSON="$(as_bool01 "$OUTPUT_JSON")"
RUN_CATCHUP_SMOKE="$(as_bool01 "$RUN_CATCHUP_SMOKE")"
RUN_WS_SCHEMA_PRECHECK="$(as_bool01 "$RUN_WS_SCHEMA_PRECHECK")"
ENSURE_UP="$(as_bool01 "$ENSURE_UP")"
CLEANUP_STACK="$(as_bool01 "$CLEANUP_STACK")"
LOAD_100K_ALLOW_LOW_ULIMIT="$(as_bool01 "${LOAD_100K_ALLOW_LOW_ULIMIT:-0}")"
LOAD_100K_ALLOW_LOW_EPHEMERAL="$(as_bool01 "${LOAD_100K_ALLOW_LOW_EPHEMERAL:-0}")"
WS_PRECHECK_SCHEMA="$(printf '%s' "$WS_PRECHECK_SCHEMA" | xargs)"
WS_PRECHECK_TOKEN="$(printf '%s' "$WS_PRECHECK_TOKEN" | xargs)"
WS_PRECHECK_TIMEOUT_MS="$(printf '%s' "$WS_PRECHECK_TIMEOUT_MS" | xargs)"
WS_PRECHECK_AUCTION="$(printf '%s' "$WS_PRECHECK_AUCTION" | xargs)"

if ! is_true "$CONFIRM"; then
  echo "Refuse to run super-stretch without --confirm."
  echo "This lane is non-P0 and may cause heavy load; add --confirm after manual review."
  exit 2
fi

if ! command -v make >/dev/null 2>&1; then
  echo "required: make"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "required: curl"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi
if ! command -v grep >/dev/null 2>&1; then
  echo "required: grep"
  exit 1
fi
if [[ "$RUN_CATCHUP_SMOKE" == "1" || "$RUN_WS_SCHEMA_PRECHECK" == "1" ]] && ! command -v node >/dev/null 2>&1; then
  echo "required: node (for --catchup-smoke / --ws-precheck)"
  exit 1
fi

if [[ "$RUN_WS_SCHEMA_PRECHECK" == "1" ]] && ! is_positive_int "$WS_PRECHECK_SCHEMA"; then
  echo "required: WS_PRECHECK_SCHEMA must be positive integer when --ws-precheck is set"
  exit 1
fi

if [[ "$RUN_WS_SCHEMA_PRECHECK" == "1" ]] && ! is_positive_int "$WS_PRECHECK_TIMEOUT_MS"; then
  echo "invalid WS_PRECHECK_TIMEOUT_MS=$WS_PRECHECK_TIMEOUT_MS; must be positive integer"
  exit 1
fi

if ! is_positive_int "$ATTEMPTS"; then
  echo "--attempts must be a positive integer"
  exit 1
fi

if ! is_non_negative_int "$INTERVAL"; then
  echo "--interval must be a non-negative integer"
  exit 1
fi

if ! is_positive_int "$LOAD_OBSERVERS"; then
  echo "--observers must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_BIDDERS"; then
  echo "--bidders must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_SHARDS"; then
  echo "--shards must be a positive integer"
  exit 1
fi

if ! is_positive_int "$LOAD_DURATION_SEC"; then
  echo "--duration must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_AUCTION_DUR_SEC"; then
  echo "--auction-dur must be a positive integer"
  exit 1
fi
if ! is_non_negative_int "$LOAD_BID_INTERVAL_MS"; then
  echo "--bid-interval must be a non-negative integer"
  exit 1
fi
if ! is_positive_int "$LOAD_ACK_P95_MS"; then
  echo "--ack-p95 must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_BROADCAST_P95_MS"; then
  echo "--broadcast-p95 must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_HAMMER_P95_MS"; then
  echo "--hammer-p95 must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_SCRIPT_P99_MS"; then
  echo "--script-p99 must be a positive integer"
  exit 1
fi
if ! is_positive_int "$LOAD_CATCHUP_P95_MS"; then
  echo "--catchup-p95 must be a positive integer"
  exit 1
fi
if ! is_non_negative_int "$LOAD_OBSERVER_STAGGER_MS"; then
  echo "--observer-stagger must be a non-negative integer"
  exit 1
fi
if ! is_non_negative_int "$MIN_PEAK_ACTIVE_CONNECTIONS"; then
  echo "--min-peak-active-connections must be a non-negative integer"
  exit 1
fi

if [[ "$PACK_LABEL" == "" ]]; then
  PACK_LABEL="$(date -u +%Y%m%dT%H%M%SZ)"
else
  PACK_LABEL="$(echo "$PACK_LABEL" | sed 's/[^A-Za-z0-9._-]/-/g')"
fi

if [[ -n "${BASE_WS_URL:-}" ]]; then
  if [[ "$BASE_WS_URL" == https://* ]]; then
    BASE_WS_URL="wss://${BASE_WS_URL#https://}"
  elif [[ "$BASE_WS_URL" == http://* ]]; then
    BASE_WS_URL="ws://${BASE_WS_URL#http://}"
  fi
else
  if [[ "$BASE_URL" == https://* ]]; then
    BASE_WS_URL="wss://${BASE_URL#https://}"
  elif [[ "$BASE_URL" == http://* ]]; then
    BASE_WS_URL="ws://${BASE_URL#http://}"
  else
    BASE_WS_URL="$BASE_URL"
  fi
fi
BASE_WS_URL="${BASE_WS_URL%/ws/}"
BASE_WS_URL="${BASE_WS_URL%/ws}"
BASE_WS_URL="${BASE_WS_URL%/}"

PACK_DIR="${PACK_DIR_BASE}/${PACK_LABEL}"
mkdir -p "$PACK_DIR/runs"
summary_file="$PACK_DIR/summary.tsv"
manifest_file="$PACK_DIR/manifest.json"
preflight_report_dir="$PACK_DIR/preflight"
preflight_status_file="$preflight_report_dir/status.tsv"
preflight_status_exists=0

auction_mode_label="${LOAD_AUCTION_MODE_NORMALIZED}"
auction_mode_label="${auction_mode_label:-first_price}"
echo -n "#run\tstatus\trc\trun_dir\tlog_file\tmetrics_file\tauction_id\tauction_ids\tauction_mode\tactive_connections\tobserver_read_errors\tobserver_dial_errors\tbid_sent\tbid_acked\tbid_rejected\tbid_errors\tseq_gap_count\tbackpressure_force_close\tpanic_present\tcatchup_status\tcatchup_rc\tcatchup_log\tws_precheck_status\tws_precheck_rc\tws_precheck_log" > "$summary_file"
echo >> "$summary_file"

HEALTHZ_URL="${BASE_URL}/healthz"
METRICS_URL="${BASE_URL}/metrics"

echo "super-stretch rehearsal pack: $PACK_DIR"
echo "params: observers=$LOAD_OBSERVERS bidders=$LOAD_BIDDERS shards=$LOAD_SHARDS duration=${LOAD_DURATION_SEC}s bid_interval=${LOAD_BID_INTERVAL_MS}ms auction_mode=$auction_mode_label"

LOAD_100K_CONFIRM=1 \
LOAD_100K_ALLOW_LOW_ULIMIT="${LOAD_100K_ALLOW_LOW_ULIMIT:-}" \
LOAD_100K_PREFLIGHT_OUT_DIR="$preflight_report_dir" \
make load-100k-preflight
if [ -f "$preflight_status_file" ]; then preflight_status_exists=1; fi

if [[ "$ENSURE_UP" == "1" ]] && ! curl -sf "$HEALTHZ_URL" >/dev/null 2>&1; then
  echo ">>> bringing stack up before rehearsal"
  make up
fi

if ! curl -sf "$HEALTHZ_URL" >/dev/null 2>&1; then
  echo "healthz is not reachable; use --up or start stack first"
  exit 1
fi

start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
health_start_file="$PACK_DIR/health-start.json"
health_end_file="$PACK_DIR/health-end.json"
echo "{}" > "$health_start_file"
echo "{}" > "$health_end_file"
json_payload="$(mktemp)"
cleanup_tmp() {
  rm -f "$json_payload"
}
trap cleanup_tmp EXIT
curl -sS "$HEALTHZ_URL" > "$health_start_file" || true

extract_metric() {
  local line="$1"
  local key="$2"
  local extracted
  if [[ "$line" == *"${key}="* ]]; then
    extracted="$(sed -n "s/.*${key}=\\([0-9][0-9]*\\).*/\\1/p" <<<"$line")"
    if [[ -n "$extracted" ]]; then
      echo "$extracted"
      return
    fi
  fi
  echo 0
}

extract_json_metric() {
  local file="$1"
  local filter="$2"
  local value

  value="$(jq -er "$filter" "$file" 2>/dev/null | sed 's/\r$//' || true)"
  if [[ -z "$value" ]] || [[ "$value" == "null" ]] || ! is_non_negative_int "$value"; then
    echo 0
    return
  fi
  echo "$value"
}

extract_auction_ids() {
  local log_file="$1"
  local ids

  ids="$(grep -m1 '^LOAD_AUCTION_IDS=' "$log_file" | sed 's/^LOAD_AUCTION_IDS=//')"
  if [[ -z "$ids" ]]; then
    ids="$(grep -m1 '^LOAD_AUCTION_ID=' "$log_file" | sed 's/^LOAD_AUCTION_ID=//')"
  fi

  ids="${ids//$'\r'/}"
  ids="${ids// /}"
  echo "$ids"
}

printf '[' > "$json_payload"

pass=0
failed=0
total_read_errors=0
total_dial_errors=0
total_bid_sents=0
total_bid_acked=0
total_bid_rejected=0
total_bid_errors=0
total_seq_gap_count=0
total_backpressure_force_close=0
total_peak_active_connections=0
total_panic_runs=0
total_catchup_runs=0
total_catchup_pass=0
total_catchup_failed=0
total_ws_precheck_runs=0
total_ws_precheck_pass=0
total_ws_precheck_failed=0
ws_precheck_auction_resolved="${WS_PRECHECK_AUCTION}"

run_idx=0
while (( run_idx < ATTEMPTS )); do
  run_idx=$((run_idx + 1))
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  run_tag="$(printf 'run-%02d-%s' "$run_idx" "$ts")"
  run_dir="$PACK_DIR/runs/$run_tag"
  log_file="$run_dir/load.log"
  metrics_file="$run_dir/metrics.txt"
  mkdir -p "$run_dir"

  if (( run_idx > 1 )) && (( INTERVAL > 0 )); then
    sleep "$INTERVAL"
  fi

  echo ">>> run #${run_idx}/${ATTEMPTS}: $run_tag"
  set +e
  LOAD_OBSERVERS="$LOAD_OBSERVERS" \
  LOAD_BIDDERS="$LOAD_BIDDERS" \
  LOAD_SHARDS="$LOAD_SHARDS" \
  LOAD_DURATION_SEC="$LOAD_DURATION_SEC" \
  LOAD_BID_INTERVAL_MS="$LOAD_BID_INTERVAL_MS" \
  LOAD_AUCTION_MODE="$auction_mode_label" \
  LOAD_AUCTION_DUR_SEC="$LOAD_AUCTION_DUR_SEC" \
  LOAD_ACK_P95_MS="$LOAD_ACK_P95_MS" \
  LOAD_BROADCAST_P95_MS="$LOAD_BROADCAST_P95_MS" \
  LOAD_HAMMER_P95_MS="$LOAD_HAMMER_P95_MS" \
  LOAD_SCRIPT_P99_MS="$LOAD_SCRIPT_P99_MS" \
  LOAD_CATCHUP_P95_MS="$LOAD_CATCHUP_P95_MS" \
  LOAD_OBSERVER_STAGGER_MS="$LOAD_OBSERVER_STAGGER_MS" \
  LOAD_100K_CONFIRM=1 \
  LOAD_100K_ALLOW_LOW_ULIMIT="${LOAD_100K_ALLOW_LOW_ULIMIT:-}" \
  LOAD_100K_ALLOW_LOW_EPHEMERAL="${LOAD_100K_ALLOW_LOW_EPHEMERAL:-}" \
  LOAD_RESET_METRICS=1 \
  make load 2>&1 | tee "$log_file"
  rc="${PIPESTATUS[0]}"
  set -e

  auction_ids="$(extract_auction_ids "$log_file")"
  if [[ -n "${auction_ids:-}" ]]; then
    auction_id="${auction_ids%%,*}"
  else
    auction_id=""
  fi

  curl -sS "$METRICS_URL" > "$metrics_file" || true
  active_connections="$(extract_json_metric "$metrics_file" '.activeConns // .active_connections // .connections.active // .ws.activeConns // .ws.active_connections // .lumen.activeConns // .lumen_ws_active_connections')"
  if (( active_connections > total_peak_active_connections )); then
    total_peak_active_connections="$active_connections"
  fi

  observer_line="$(grep -n '^observer:' "$log_file" | tail -n1 | sed 's/^.*observer: //')"
  bidder_line="$(grep -n '^bidder:' "$log_file" | tail -n1 | sed 's/^.*bidder: //')"
  observer_frames="$(extract_metric "$observer_line" frames)"
  observer_read_errors="$(extract_metric "$observer_line" readErrors)"
  observer_dial_errors="$(extract_metric "$observer_line" dialErrors)"
  bidder_sent="$(extract_metric "$bidder_line" sent)"
  bidder_acked="$(extract_metric "$bidder_line" acked)"
  bidder_rejected="$(extract_metric "$bidder_line" rejected)"
  bidder_errors="$(extract_metric "$bidder_line" errors)"
  counter_line="$(grep -n '^counters:' "$log_file" | tail -n1 | sed 's/^.*counters: //')"
  seq_gap_count="$(extract_metric "$counter_line" seqGapCount)"
  backpressure_force_close="$(extract_metric "$counter_line" backpressureForceClose)"

  if grep -q 'panic:' "$log_file"; then
    run_panic=1
  else
    run_panic=0
  fi

  if [ "$rc" != "0" ]; then
    run_status="FAIL"
  elif [ -z "${auction_id:-}" ]; then
    run_status="FAIL"
  elif grep -q '^load: PASS$' "$log_file"; then
    run_status="PASS"
  else
    run_status="FAIL"
  fi

  if [ "$run_status" = "PASS" ]; then
    if (( observer_read_errors > 0 )) || (( seq_gap_count > 0 )) || (( backpressure_force_close > 0 )) || (( run_panic > 0 )); then
      run_status="FAIL"
    fi
  fi

  total_read_errors=$((total_read_errors + observer_read_errors))
  total_dial_errors=$((total_dial_errors + observer_dial_errors))
  total_bid_sents=$((total_bid_sents + bidder_sent))
  total_bid_acked=$((total_bid_acked + bidder_acked))
  total_bid_rejected=$((total_bid_rejected + bidder_rejected))
  total_bid_errors=$((total_bid_errors + bidder_errors))
  total_seq_gap_count=$((total_seq_gap_count + seq_gap_count))
  total_backpressure_force_close=$((total_backpressure_force_close + backpressure_force_close))
  if (( run_panic > 0 )); then
    total_panic_runs=$((total_panic_runs + 1))
  fi

  catchup_status="SKIP"
  catchup_rc="-"
  catchup_log="-"
  ws_precheck_status="SKIP"
  ws_precheck_rc="-"
  ws_precheck_log="-"
  ws_precheck_effective_auction="${WS_PRECHECK_AUCTION}"
  if [[ "$RUN_CATCHUP_SMOKE" == "1" ]]; then
    catchup_log="$run_dir/catchup.log"
    if [[ -n "${auction_id:-}" ]]; then
      set +e
      (
        export AUCTION_ID="$auction_id"
        export HOST_HTTP="$BASE_URL"
        export HOST_WS="$BASE_WS_URL"
        node "$SCRIPT_ROOT/apps/web/scripts/smoke-catchup.mjs" > "$catchup_log" 2>&1
      )
      catchup_rc="$?"
      set -e
      total_catchup_runs=$((total_catchup_runs + 1))
      if [[ "$catchup_rc" == "0" ]]; then
        catchup_status="PASS"
        total_catchup_pass=$((total_catchup_pass + 1))
      else
        catchup_status="FAIL"
        total_catchup_failed=$((total_catchup_failed + 1))
      fi

    else
      catchup_status="SKIP_NO_AUCTION"
    fi
  fi

  if [[ "$RUN_WS_SCHEMA_PRECHECK" == "1" ]]; then
    if [[ -z "$ws_precheck_effective_auction" ]]; then
      ws_precheck_effective_auction="${auction_id:-}"
    fi
    if [[ -n "$ws_precheck_effective_auction" ]]; then
      ws_precheck_log="$run_dir/ws-schema-precheck.log"
      if [[ -z "$ws_precheck_auction_resolved" ]]; then
        ws_precheck_auction_resolved="$ws_precheck_effective_auction"
      fi
      set +e
      (
        WS_PRECHECK_AUCTION="$ws_precheck_effective_auction" \
        WS_PRECHECK_SCHEMA="$WS_PRECHECK_SCHEMA" \
        WS_PRECHECK_TOKEN="$WS_PRECHECK_TOKEN" \
        WS_PRECHECK_TIMEOUT_MS="$WS_PRECHECK_TIMEOUT_MS" \
        node "$SCRIPT_ROOT/scripts/ws-schema-precheck.mjs" --url "${BASE_WS_URL}/ws" > "$ws_precheck_log" 2>&1
      )
      ws_precheck_rc="$?"
      set -e
      total_ws_precheck_runs=$((total_ws_precheck_runs + 1))
      if [[ "$ws_precheck_rc" == "0" ]]; then
        ws_precheck_status="PASS"
        total_ws_precheck_pass=$((total_ws_precheck_pass + 1))
      else
        ws_precheck_status="FAIL"
        total_ws_precheck_failed=$((total_ws_precheck_failed + 1))
      fi
    else
      ws_precheck_status="SKIP_NO_AUCTION"
    fi
  else
    ws_precheck_status="SKIP_DISABLED"
  fi

  if [ "$run_status" = "PASS" ] && [[ "$RUN_CATCHUP_SMOKE" == "1" ]] && [ "$catchup_status" = "FAIL" ]; then
    run_status="FAIL"
  fi
  if [ "$run_status" = "PASS" ] && [[ "$RUN_WS_SCHEMA_PRECHECK" == "1" ]] && [ "$ws_precheck_status" = "FAIL" ]; then
    run_status="FAIL"
  fi

  if [ -n "${auction_id:-}" ]; then
    printf '%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s' \
      "$run_idx" "$run_status" "$rc" "$run_dir" "$log_file" "$metrics_file" "$auction_id" "${auction_ids:-}" \
      "$auction_mode_label" \
      "$active_connections" "$observer_read_errors" "$observer_dial_errors" "$bidder_sent" "$bidder_acked" "$bidder_rejected" "$bidder_errors" \
      "$seq_gap_count" "$backpressure_force_close" "$run_panic" "$catchup_status" "$catchup_rc" "$catchup_log" "$ws_precheck_status" "$ws_precheck_rc" "$ws_precheck_log" >> "$summary_file"
    printf '\n' >> "$summary_file"
  else
    printf '%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s' \
      "$run_idx" "$run_status" "$rc" "$run_dir" "$log_file" "$metrics_file" "-" "-" \
      "$auction_mode_label" \
      "$active_connections" "$observer_read_errors" "$observer_dial_errors" "$bidder_sent" "$bidder_acked" "$bidder_rejected" "$bidder_errors" \
      "$seq_gap_count" "$backpressure_force_close" "$run_panic" "$catchup_status" "$catchup_rc" "$catchup_log" "$ws_precheck_status" "$ws_precheck_rc" "$ws_precheck_log" >> "$summary_file"
    printf '\n' >> "$summary_file"
  fi

  if [[ "$run_status" == "PASS" ]]; then
    pass=$((pass + 1))
  else
    failed=$((failed + 1))
  fi

  echo "run ${run_idx}: status=${run_status} rc=${rc} activeConns=${active_connections} observer.readErrors=${observer_read_errors} observer.dialErrors=${observer_dial_errors} bidder.sent=${bidder_sent} bidder.acked=${bidder_acked} seqGapCount=${seq_gap_count} backpressureForceClose=${backpressure_force_close}"

  run_obj="$(jq -nc \
    --arg run "${run_idx}" \
    --arg status "$run_status" \
    --arg rc "$rc" \
    --arg run_dir "$run_dir" \
    --arg auction_id "$auction_id" \
    --arg auction_ids "$auction_ids" \
    --arg observer_read_errors "$observer_read_errors" \
    --arg observer_dial_errors "$observer_dial_errors" \
    --arg observer_frames "$observer_frames" \
    --arg bidder_sent "$bidder_sent" \
    --arg bidder_acked "$bidder_acked" \
    --arg bidder_rejected "$bidder_rejected" \
    --arg bidder_errors "$bidder_errors" \
    --arg seq_gap_count "$seq_gap_count" \
    --arg backpressure_force_close "$backpressure_force_close" \
    --arg panic "$run_panic" \
    --arg catchup_status "$catchup_status" \
    --arg catchup_rc "$catchup_rc" \
    --arg catchup_log "$catchup_log" \
    --arg ws_precheck_status "$ws_precheck_status" \
    --arg ws_precheck_rc "$ws_precheck_rc" \
    --arg ws_precheck_log "$ws_precheck_log" \
    --arg ws_precheck_schema "$WS_PRECHECK_SCHEMA" \
    --arg ws_precheck_token_set "${WS_PRECHECK_TOKEN:+true}" \
  --arg ws_precheck_auction "$ws_precheck_effective_auction" \
  --arg run_ws_precheck_enabled "$RUN_WS_SCHEMA_PRECHECK" \
  --arg run_catchup_enabled "$RUN_CATCHUP_SMOKE" \
  --arg log "$log_file" \
  --arg metrics "$metrics_file" \
  --arg active_connections "$active_connections" \
  '{run: ($run|tonumber), status: $status, rc: ($rc|tonumber), run_dir: $run_dir, auction_id: $auction_id, auction_ids: ($auction_ids | split(",") | map(select(length > 0))), observer_read_errors: ($observer_read_errors|tonumber), observer_dial_errors: ($observer_dial_errors|tonumber), observer_frames: ($observer_frames|tonumber), bidder_sent: ($bidder_sent|tonumber), bidder_acked: ($bidder_acked|tonumber), bidder_rejected: ($bidder_rejected|tonumber), bidder_errors: ($bidder_errors|tonumber), seq_gap_count: ($seq_gap_count|tonumber), backpressure_force_close: ($backpressure_force_close|tonumber), active_connections: ($active_connections|tonumber), panic_present: ($panic == "1"), catchup: {enabled: ((($run_catchup_enabled|tostring|ascii_downcase) == "1" or ($run_catchup_enabled|tostring|ascii_downcase) == "true"), status: $catchup_status, rc: (if $catchup_rc == "-" then null else ($catchup_rc|tonumber) end), log: $catchup_log}, ws_precheck: {enabled: ((($run_ws_precheck_enabled|tostring|ascii_downcase) == "1" or ($run_ws_precheck_enabled|tostring|ascii_downcase) == "true"), status: $ws_precheck_status, rc: (if $ws_precheck_rc == "-" then null else ($ws_precheck_rc|tonumber) end), schema: (if $ws_precheck_schema == "" then null else ($ws_precheck_schema|tonumber) end), token_set: (if $ws_precheck_token_set == "true" then true else false end), auction_override: $ws_precheck_auction, log: $ws_precheck_log}, log: $log, metrics: $metrics}')"

  if (( run_idx > 1 )); then
    printf ',' >> "$json_payload"
  fi
  printf '%s\n' "$run_obj" >> "$json_payload"
done

printf ']\n' >> "$json_payload"
curl -sS "$HEALTHZ_URL" > "$health_end_file" || true

pass_rate=0
if (( ATTEMPTS > 0 )); then
  pass_rate="$(awk -v p="$pass" -v t="$ATTEMPTS" 'BEGIN { printf "%.1f", (p*100)/t }')"
fi
if (( MIN_PEAK_ACTIVE_CONNECTIONS > 0 )) && (( total_peak_active_connections < MIN_PEAK_ACTIVE_CONNECTIONS )); then
  echo "rehearsal failed: observed peak active connections=${total_peak_active_connections}, required min=${MIN_PEAK_ACTIVE_CONNECTIONS}"
  failed=$((failed + 1))
fi

end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -cn \
  --arg pack_dir "$PACK_DIR" \
  --arg run_script "${0}" \
  --arg command_line "$SCRIPT_COMMAND_LINE" \
  --arg git_head "$SCRIPT_GIT_HEAD" \
  --arg run_host "$SCRIPT_HOST" \
  --arg run_user "$SCRIPT_USER" \
  --arg start "$start_ts" \
  --arg end "$end_ts" \
  --arg now "$SCRIPT_UTC_NOW" \
  --arg attempts "$ATTEMPTS" \
  --arg interval "$INTERVAL" \
  --arg label "$PACK_LABEL" \
  --arg pack_dir_base "$PACK_DIR_BASE" \
  --arg ensure_up "$ENSURE_UP" \
  --arg cleanup_stack "$CLEANUP_STACK" \
  --arg base_url "$BASE_URL" \
  --arg pass "$pass" \
  --arg failed "$failed" \
  --arg pass_rate "$pass_rate" \
  --arg load_observers "$LOAD_OBSERVERS" \
  --arg load_bidders "$LOAD_BIDDERS" \
  --arg load_shards "$LOAD_SHARDS" \
  --arg load_duration "$LOAD_DURATION_SEC" \
  --arg load_bid_interval "$LOAD_BID_INTERVAL_MS" \
  --arg load_auction_mode "$auction_mode_label" \
  --arg load_auction_dur "$LOAD_AUCTION_DUR_SEC" \
  --arg load_ack_p95 "$LOAD_ACK_P95_MS" \
  --arg load_broadcast_p95 "$LOAD_BROADCAST_P95_MS" \
  --arg load_script_p99 "$LOAD_SCRIPT_P99_MS" \
  --arg load_hammer_p95 "$LOAD_HAMMER_P95_MS" \
  --arg load_catchup_p95 "$LOAD_CATCHUP_P95_MS" \
  --arg load_observer_stagger_ms "$LOAD_OBSERVER_STAGGER_MS" \
  --arg load_100k_confirm "$CONFIRM" \
  --arg load_100k_allow_low_ulimit "${LOAD_100K_ALLOW_LOW_ULIMIT:-0}" \
  --arg load_100k_allow_low_ephemeral "${LOAD_100K_ALLOW_LOW_EPHEMERAL:-0}" \
  --arg total_read_errors "$total_read_errors" \
  --arg total_dial_errors "$total_dial_errors" \
  --arg total_panic_runs "$total_panic_runs" \
  --arg total_bid_sents "$total_bid_sents" \
  --arg total_bid_acked "$total_bid_acked" \
  --arg total_bid_rejected "$total_bid_rejected" \
  --arg total_bid_errors "$total_bid_errors" \
  --arg total_seq_gap_count "$total_seq_gap_count" \
  --arg total_backpressure_force_close "$total_backpressure_force_close" \
  --arg min_peak_active_connections "$MIN_PEAK_ACTIVE_CONNECTIONS" \
  --arg run_catchup_enabled "$RUN_CATCHUP_SMOKE" \
  --arg run_ws_precheck_enabled "$RUN_WS_SCHEMA_PRECHECK" \
  --arg catchup_runs "$total_catchup_runs" \
  --arg catchup_pass "$total_catchup_pass" \
  --arg catchup_failed "$total_catchup_failed" \
  --arg ws_precheck_runs "$total_ws_precheck_runs" \
  --arg ws_precheck_pass "$total_ws_precheck_pass" \
  --arg ws_precheck_failed "$total_ws_precheck_failed" \
  --arg ws_precheck_schema "$WS_PRECHECK_SCHEMA" \
  --arg ws_precheck_timeout_ms "$WS_PRECHECK_TIMEOUT_MS" \
  --arg ws_precheck_token_set "${WS_PRECHECK_TOKEN:+true}" \
  --arg ws_precheck_auction "$ws_precheck_auction_resolved" \
  --arg base_ws_url "$BASE_WS_URL" \
  --arg preflight_dir "$preflight_report_dir" \
  --arg preflight_status "$preflight_status_file" \
  --arg preflight_status_exists "$preflight_status_exists" \
  --arg health_start "$health_start_file" \
  --arg health_end "$health_end_file" \
  --rawfile runs "$json_payload" \
  '{pack_dir: $pack_dir, pack_dir_base: $pack_dir_base, pack_label: $label, command_line: $command_line, run_metadata: {script: $run_script, git_head: $git_head, host: $run_host, user: $run_user, captured_at_utc: $now, base_url: $base_url, ws_url: $base_ws_url}, started_at: $start, finished_at: $end, params: {observers: ($load_observers|tonumber), bidders: ($load_bidders|tonumber), shards: ($load_shards|tonumber), duration_sec: ($load_duration|tonumber), bid_interval_ms: ($load_bid_interval|tonumber), auction_mode: $load_auction_mode, auction_dur_sec: ($load_auction_dur|tonumber), attempt_interval_sec: ($interval|tonumber), budgets_ms: {ack_p95: ($load_ack_p95|tonumber), broadcast_p95: ($load_broadcast_p95|tonumber), script_p99: ($load_script_p99|tonumber), hammer_p95: ($load_hammer_p95|tonumber), catchup_p95: ($load_catchup_p95|tonumber)}, observer_stagger_ms: ($load_observer_stagger_ms|tonumber), min_peak_active_connections: ($min_peak_active_connections|tonumber), confirm: ((($load_100k_confirm|tostring|ascii_downcase) == \"1\" or ($load_100k_confirm|tostring|ascii_downcase) == \"true\" or ($load_100k_confirm|tostring|ascii_downcase) == \"yes\" or ($load_100k_confirm|tostring|ascii_downcase) == \"on\")), allow_low_ulimit: ((($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"1\" or ($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"true\" or ($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"yes\" or ($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"on\")), allow_low_ephemeral: ((($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"1\" or ($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"true\" or ($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"yes\" or ($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"on\")), attempts: {total: ($attempts|tonumber), pass: ($pass|tonumber), failed: ($failed|tonumber), pass_rate_pct: ($pass_rate|tonumber)}, orchestration: {ensure_up: ((($ensure_up|tostring|ascii_downcase) == \"1\" or ($ensure_up|tostring|ascii_downcase) == \"true\"), cleanup_stack: ((($cleanup_stack|tostring|ascii_downcase) == \"1\" or ($cleanup_stack|tostring|ascii_downcase) == \"true\") )}, totals: {observer_read_errors: ($total_read_errors|tonumber), observer_dial_errors: ($total_dial_errors|tonumber), panic_runs: ($total_panic_runs|tonumber), bidder_sent: ($total_bid_sents|tonumber), bidder_acked: ($total_bid_acked|tonumber), bidder_rejected: ($total_bid_rejected|tonumber), bidder_errors: ($total_bid_errors|tonumber), seq_gap_count: ($total_seq_gap_count|tonumber), backpressure_force_close: ($total_backpressure_force_close|tonumber), max_active_connections: ($total_peak_active_connections|tonumber)}, catchup_checks: {enabled: ((($run_catchup_enabled|tostring|ascii_downcase) == \"1\" or ($run_catchup_enabled|tostring|ascii_downcase) == \"true\"), runs: ($catchup_runs|tonumber), pass: ($catchup_pass|tonumber), failed: ($catchup_failed|tonumber)}, ws_precheck_checks: {enabled: ((($run_ws_precheck_enabled|tostring|ascii_downcase) == \"1\" or ($run_ws_precheck_enabled|tostring|ascii_downcase) == \"true\"), runs: ($ws_precheck_runs|tonumber), pass: ($ws_precheck_pass|tonumber), failed: ($ws_precheck_failed|tonumber), schema: (if $ws_precheck_schema == \"\" then null else ($ws_precheck_schema|tonumber) end), timeout_ms: ($ws_precheck_timeout_ms|tonumber), token_set: (if $ws_precheck_token_set == \"true\" then true else false end), auction_override: $ws_precheck_auction}, health: {start_file: $health_start, end_file: $health_end}, preflight: {dir: $preflight_dir, status_file: (if $preflight_status_exists == "1" then $preflight_status else "-"), status_exists: (($preflight_status_exists|tonumber) == 1)}, runs: ($runs|fromjson)}' > "$manifest_file"

if [[ "$OUTPUT_JSON" == "1" ]]; then
  cat "$manifest_file"
fi

echo "manifest: $manifest_file"
echo "summary: $summary_file"

if [[ "$CLEANUP_STACK" == "1" ]]; then
  echo ">>> stopping stack (make down)"
  make down
fi

if (( failed > 0 )); then
  exit 1
fi
