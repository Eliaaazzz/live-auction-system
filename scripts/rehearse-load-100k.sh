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

Options:
  --confirm            required; explicit opt-in for non-P0 rehearsal
  --allow-low-ulimit   set LOAD_100K_ALLOW_LOW_ULIMIT=1 (or true/yes/on)
  --allow-low-ephemeral set LOAD_100K_ALLOW_LOW_EPHEMERAL=1 (or true/yes/on)
  --attempts N         number of load runs (default: 1)
  --interval SEC       sleep between attempts (default: 0)
  --label STR          label suffix for output directory (default: timestamp)
  --base-url URL       override BASE_URL for health/metrics checks
  --pack-dir DIR       base output dir (default: .load-100k-rehearsals)
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
  --json               print manifest JSON to stdout at end
  --catchup-smoke      run ROOM_JOIN catchup smoke after each attempt
  -h, --help           show this help

Output:
  .load-100k-rehearsals/<label>/
    manifest.json
    summary.tsv
    runs/run-01-*.log
    runs/run-01-*.metrics
EOF
}

ATTEMPTS=1
INTERVAL=0
CONFIRM="${CONFIRM:-0}"
OUTPUT_JSON="${OUTPUT_JSON:-0}"
RUN_CATCHUP_SMOKE="${RUN_CATCHUP_SMOKE:-0}"
PACK_DIR_BASE=".load-100k-rehearsals"
PACK_LABEL=""
BASE_URL="${BASE_URL:-${TARGET_URL:-http://localhost:8080}}"
BASE_URL="${BASE_URL%/}"
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
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_auction_mode() {
  local mode="${1:-}"
  mode="$(printf '%s' "$mode" | tr '[:upper:]' '[:lower:]')"
  mode="${mode//-/_}"
  mode="$(printf '%s' "$mode" | tr -s '[:space:]' '_')"
  mode="${mode//__/_}"
  case "$mode" in
    ""|"first"|"first_price"|"firstprice")
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

as_bool01() {
  if is_true "$1"; then
    echo 1
  else
    echo 0
  fi
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
    --catchup-smoke)
      RUN_CATCHUP_SMOKE=1
      shift
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
  echo "supported: first_price (first), firstprice, second_price (second), secondprice, vickrey."
  exit 2
fi

CONFIRM="$(as_bool01 "$CONFIRM")"
OUTPUT_JSON="$(as_bool01 "$OUTPUT_JSON")"
RUN_CATCHUP_SMOKE="$(as_bool01 "$RUN_CATCHUP_SMOKE")"
ENSURE_UP="$(as_bool01 "$ENSURE_UP")"
CLEANUP_STACK="$(as_bool01 "$CLEANUP_STACK")"
LOAD_100K_ALLOW_LOW_ULIMIT="$(as_bool01 "${LOAD_100K_ALLOW_LOW_ULIMIT:-0}")"
LOAD_100K_ALLOW_LOW_EPHEMERAL="$(as_bool01 "${LOAD_100K_ALLOW_LOW_EPHEMERAL:-0}")"

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
if [[ "$RUN_CATCHUP_SMOKE" == "1" ]] && ! command -v node >/dev/null 2>&1; then
  echo "required: node (for --catchup-smoke)"
  exit 1
fi

if [[ "$ATTEMPTS" -le 0 ]]; then
  echo "--attempts must be > 0"
  exit 1
fi

if [[ "$INTERVAL" -lt 0 ]]; then
  echo "--interval must be >= 0"
  exit 1
fi

if ! [[ "$LOAD_OBSERVERS" =~ ^[0-9]+$ && "$LOAD_BIDDERS" =~ ^[0-9]+$ && "$LOAD_SHARDS" =~ ^[0-9]+$ ]]; then
  echo "LOAD_* numeric overrides must be integers"
  exit 1
fi

if ! [[ "$LOAD_DURATION_SEC" =~ ^[0-9]+$ && "$LOAD_AUCTION_DUR_SEC" =~ ^[0-9]+$ && "$LOAD_BID_INTERVAL_MS" =~ ^[0-9]+$ ]]; then
  echo "duration/interval overrides must be integers"
  exit 1
fi

if ! [[ "$LOAD_ACK_P95_MS" =~ ^[0-9]+$ && "$LOAD_BROADCAST_P95_MS" =~ ^[0-9]+$ && "$LOAD_HAMMER_P95_MS" =~ ^[0-9]+$ \
  && "$LOAD_SCRIPT_P99_MS" =~ ^[0-9]+$ && "$LOAD_CATCHUP_P95_MS" =~ ^[0-9]+$ && "$LOAD_OBSERVER_STAGGER_MS" =~ ^[0-9]+$ ]]; then
  echo "timing overrides must be integers"
  exit 1
fi

if [[ "$PACK_LABEL" == "" ]]; then
  PACK_LABEL="$(date -u +%Y%m%dT%H%M%SZ)"
else
  PACK_LABEL="$(echo "$PACK_LABEL" | sed 's/[^A-Za-z0-9._-]/-/g')"
fi

if [[ "$BASE_URL" == https://* ]]; then
  BASE_WS_URL="wss://${BASE_URL#https://}"
elif [[ "$BASE_URL" == http://* ]]; then
  BASE_WS_URL="ws://${BASE_URL#http://}"
else
  BASE_WS_URL="$BASE_URL"
fi

PACK_DIR="${PACK_DIR_BASE}/${PACK_LABEL}"
mkdir -p "$PACK_DIR/runs"
summary_file="$PACK_DIR/summary.tsv"
manifest_file="$PACK_DIR/manifest.json"

auction_mode_label="${LOAD_AUCTION_MODE_NORMALIZED}"
auction_mode_label="${auction_mode_label:-first_price}"
echo "#run\tstatus\trc\tauction_id\tauction_ids\tauction_mode\tobserver_read_errors\tobserver_dial_errors\tbid_sent\tbid_acked\tbid_rejected\tbid_errors\tseq_gap_count\tbackpressure_force_close\tpanic_present\tcatchup_status\tcatchup_rc" > "$summary_file"

HEALTHZ_URL="${BASE_URL}/healthz"
METRICS_URL="${BASE_URL}/metrics"

echo "super-stretch rehearsal pack: $PACK_DIR"
echo "params: observers=$LOAD_OBSERVERS bidders=$LOAD_BIDDERS shards=$LOAD_SHARDS duration=${LOAD_DURATION_SEC}s bid_interval=${LOAD_BID_INTERVAL_MS}ms auction_mode=$auction_mode_label"

LOAD_100K_CONFIRM=1 \
LOAD_100K_ALLOW_LOW_ULIMIT="${LOAD_100K_ALLOW_LOW_ULIMIT:-}" \
make load-100k-preflight

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
total_panic_runs=0
total_catchup_runs=0
total_catchup_pass=0
total_catchup_failed=0

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

  if [ "$run_status" = "PASS" ] && [[ "$RUN_CATCHUP_SMOKE" == "1" ]] && [ "$catchup_status" = "FAIL" ]; then
    run_status="FAIL"
  fi

  if [ -n "${auction_id:-}" ]; then
    printf '%d\t%s\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\n' \
      "$run_idx" "$run_status" "$rc" "$auction_id" "${auction_ids:-}" \
      "$auction_mode_label" \
      "$observer_read_errors" "$observer_dial_errors" "$bidder_sent" "$bidder_acked" "$bidder_rejected" "$bidder_errors" \
      "$seq_gap_count" "$backpressure_force_close" "$run_panic" "$catchup_status" "$catchup_rc" >> "$summary_file"
  else
    printf '%d\t%s\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\n' \
      "$run_idx" "$run_status" "$rc" "-" "-" \
      "$auction_mode_label" \
      "$observer_read_errors" "$observer_dial_errors" "$bidder_sent" "$bidder_acked" "$bidder_rejected" "$bidder_errors" \
      "$seq_gap_count" "$backpressure_force_close" "$run_panic" "$catchup_status" "$catchup_rc" >> "$summary_file"
  fi

  if [[ "$run_status" == "PASS" ]]; then
    pass=$((pass + 1))
  else
    failed=$((failed + 1))
  fi

  echo "run ${run_idx}: status=${run_status} rc=${rc} observer.readErrors=${observer_read_errors} observer.dialErrors=${observer_dial_errors} bidder.sent=${bidder_sent} bidder.acked=${bidder_acked} seqGapCount=${seq_gap_count} backpressureForceClose=${backpressure_force_close}"

  run_obj="$(jq -nc \
    --arg run "${run_idx}" \
    --arg status "$run_status" \
    --arg rc "$rc" \
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
  --arg run_catchup_enabled "$RUN_CATCHUP_SMOKE" \
  --arg log "$log_file" \
  --arg metrics "$metrics_file" \
  '{run: ($run|tonumber), status: $status, rc: ($rc|tonumber), auction_id: $auction_id, auction_ids: ($auction_ids | split(",") | map(select(length > 0))), observer_read_errors: ($observer_read_errors|tonumber), observer_dial_errors: ($observer_dial_errors|tonumber), observer_frames: ($observer_frames|tonumber), bidder_sent: ($bidder_sent|tonumber), bidder_acked: ($bidder_acked|tonumber), bidder_rejected: ($bidder_rejected|tonumber), bidder_errors: ($bidder_errors|tonumber), seq_gap_count: ($seq_gap_count|tonumber), backpressure_force_close: ($backpressure_force_close|tonumber), panic_present: ($panic == "1"), catchup: {enabled: ((($run_catchup_enabled|tostring|ascii_downcase) == \"1\" or ($run_catchup_enabled|tostring|ascii_downcase) == \"true\"), status: $catchup_status, rc: (if $catchup_rc == "-" then null else ($catchup_rc|tonumber) end), log: $catchup_log}, log: $log, metrics: $metrics}')"

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
  --arg run_catchup_enabled "$RUN_CATCHUP_SMOKE" \
  --arg catchup_runs "$total_catchup_runs" \
  --arg catchup_pass "$total_catchup_pass" \
  --arg catchup_failed "$total_catchup_failed" \
  --arg base_ws_url "$BASE_WS_URL" \
  --arg health_start "$health_start_file" \
  --arg health_end "$health_end_file" \
  --rawfile runs "$json_payload" \
    '{pack_dir: $pack_dir, pack_dir_base: $pack_dir_base, pack_label: $label, command_line: $command_line, run_metadata: {script: $run_script, git_head: $git_head, host: $run_host, user: $run_user, captured_at_utc: $now, base_url: $base_url, ws_url: $base_ws_url}, started_at: $start, finished_at: $end, params: {observers: ($load_observers|tonumber), bidders: ($load_bidders|tonumber), shards: ($load_shards|tonumber), duration_sec: ($load_duration|tonumber), bid_interval_ms: ($load_bid_interval|tonumber), auction_mode: $load_auction_mode, auction_dur_sec: ($load_auction_dur|tonumber), attempt_interval_sec: ($interval|tonumber), budgets_ms: {ack_p95: ($load_ack_p95|tonumber), broadcast_p95: ($load_broadcast_p95|tonumber), script_p99: ($load_script_p99|tonumber), hammer_p95: ($load_hammer_p95|tonumber), catchup_p95: ($load_catchup_p95|tonumber)}, observer_stagger_ms: ($load_observer_stagger_ms|tonumber), confirm: ((($load_100k_confirm|tostring|ascii_downcase) == \"1\" or ($load_100k_confirm|tostring|ascii_downcase) == \"true\" or ($load_100k_confirm|tostring|ascii_downcase) == \"yes\" or ($load_100k_confirm|tostring|ascii_downcase) == \"on\")), allow_low_ulimit: ((($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"1\" or ($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"true\" or ($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"yes\" or ($load_100k_allow_low_ulimit|tostring|ascii_downcase) == \"on\")), allow_low_ephemeral: ((($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"1\" or ($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"true\" or ($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"yes\" or ($load_100k_allow_low_ephemeral|tostring|ascii_downcase) == \"on\")), attempts: {total: ($attempts|tonumber), pass: ($pass|tonumber), failed: ($failed|tonumber), pass_rate_pct: ($pass_rate|tonumber)}, orchestration: {ensure_up: ((($ensure_up|tostring|ascii_downcase) == \"1\" or ($ensure_up|tostring|ascii_downcase) == \"true\"), cleanup_stack: ((($cleanup_stack|tostring|ascii_downcase) == \"1\" or ($cleanup_stack|tostring|ascii_downcase) == \"true\") )}, totals: {observer_read_errors: ($total_read_errors|tonumber), observer_dial_errors: ($total_dial_errors|tonumber), panic_runs: ($total_panic_runs|tonumber), bidder_sent: ($total_bid_sents|tonumber), bidder_acked: ($total_bid_acked|tonumber), bidder_rejected: ($total_bid_rejected|tonumber), bidder_errors: ($total_bid_errors|tonumber), seq_gap_count: ($total_seq_gap_count|tonumber), backpressure_force_close: ($total_backpressure_force_close|tonumber)}, catchup_checks: {enabled: ((($run_catchup_enabled|tostring|ascii_downcase) == \"1\" or ($run_catchup_enabled|tostring|ascii_downcase) == \"true\"), runs: ($catchup_runs|tonumber), pass: ($catchup_pass|tonumber), failed: ($catchup_failed|tonumber)}, health: {start_file: $health_start, end_file: $health_end}, runs: ($runs|fromjson)}' > "$manifest_file"

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
