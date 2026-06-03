#!/usr/bin/env bash
set -euo pipefail

# Repeatable operator smoke helper:
# - runs `make load-smoke` multiple times
# - captures per-run logs for offline triage
# - prints a compact aggregate summary
#
# Usage:
#   scripts/repeat-load-smoke.sh [options]

usage() {
  cat <<'EOF'
Usage:
  scripts/repeat-load-smoke.sh [options]

Environment:
  BASE_URL               Base URL for backend health checks (default: http://localhost:8080)

Options:
  --attempts N       number of runs (default: 3)
  --interval SEC     sleep between attempts (default: 2)
  --base-url URL     override BASE_URL for health check
  --strict           exit non-zero if any attempt fails
  --json             emit JSON summary at the end
  --up               run `make up` before first attempt (if stack not healthy)
  --down             stop stack after all attempts complete
  --no-clean-logs    keep raw logs beyond this run directory
  -h, --help         show this help
EOF
}

ATTEMPTS=3
INTERVAL=2
STRICT=0
OUTPUT_JSON=0
ENSURE_UP=0
CLEAN_LOGS=1
CLEANUP_STACK=0
BASE_URL="${BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --attempts)
      ATTEMPTS="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --up)
      ENSURE_UP=1
      shift
      ;;
    --down)
      CLEANUP_STACK=1
      shift
      ;;
    --base-url)
      BASE_URL="$2"
      BASE_URL="${BASE_URL%/}"
      shift 2
      ;;
    --no-clean-logs)
      CLEAN_LOGS=0
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

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi

if ! command -v make >/dev/null 2>&1; then
  echo "required: make"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "required: curl"
  exit 1
fi

if ! command -v grep >/dev/null 2>&1; then
  echo "required: grep"
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

log_dir=".load-smoke-repeat"
mkdir -p "$log_dir"

if [[ "$ENSURE_UP" == "1" ]] && ! curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1; then
  echo ">>> bringing stack up before smoke loop"
  make up
fi

if ! curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1; then
  echo "healthz is not reachable; use --up or start stack first"
  exit 1
fi

failed=0
pass=0
total_read_errors=0
total_dial_errors=0
total_bid_errors=0
total_bid_sents=0
total_bid_acked=0
total_bid_rejected=0
total_seq_gap_count=0
total_backpressure_force_close=0
total_panic_runs=0

json_payload=$(mktemp)
trap 'rm -f "$json_payload"' EXIT
printf '[' > "$json_payload"

run_idx=0
while (( run_idx < ATTEMPTS )); do
  run_idx=$((run_idx + 1))
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  log_file="${log_dir}/load-smoke-${run_idx}-${ts}.log"

  if (( run_idx > 1 )) && (( INTERVAL > 0 )); then
    sleep "$INTERVAL"
  fi

  echo ">>> run #${run_idx}/${ATTEMPTS}: ${log_file}"
  set +e
  make load-smoke 2>&1 | tee "$log_file"
  rc="${PIPESTATUS[0]}"
  set -e
  auction_ids="$(extract_auction_ids "$log_file")"
  if [[ -n "${auction_ids:-}" ]]; then
    auction_id="${auction_ids%%,*}"
  else
    auction_id=""
  fi

  observer_line="$(grep -n '^observer:' "$log_file" | tail -n1 | cut -d: -f2- | sed 's/^ *//')"
  bidder_line="$(grep -n '^bidder:' "$log_file" | tail -n1 | cut -d: -f2- | sed 's/^ *//')"
  panic_present=0
  if grep -q 'panic:' "$log_file"; then
    panic_present=1
  fi

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

  total_read_errors=$((total_read_errors + observer_read_errors))
  total_dial_errors=$((total_dial_errors + observer_dial_errors))
  total_bid_errors=$((total_bid_errors + bidder_errors))
  total_bid_sents=$((total_bid_sents + bidder_sent))
  total_bid_acked=$((total_bid_acked + bidder_acked))
  total_bid_rejected=$((total_bid_rejected + bidder_rejected))
  total_seq_gap_count=$((total_seq_gap_count + seq_gap_count))
  total_backpressure_force_close=$((total_backpressure_force_close + backpressure_force_close))

  status="PASS"
  if (( rc != 0 )) || [ -z "${auction_id:-}" ] || ! grep -q '^load: PASS$' "$log_file" \
    || (( observer_read_errors > 0 )) || (( panic_present > 0 )); then
    status="FAIL"
    failed=$((failed + 1))
  else
    pass=$((pass + 1))
  fi
  if (( panic_present > 0 )); then
    total_panic_runs=$((total_panic_runs + 1))
  fi

  load_accept_rate="N/A"
  if (( bidder_sent > 0 )); then
    load_accept_rate="$(awk -v s="$bidder_sent" -v a="$bidder_acked" 'BEGIN { printf "%.2f", (a*100)/s }')%"
  fi

  echo "run ${run_idx}: status=${status} rc=${rc} observer.readErrors=${observer_read_errors} observer.dialErrors=${observer_dial_errors} bidder.accept_rate=${load_accept_rate} seqGapCount=${seq_gap_count} backpressureForceClose=${backpressure_force_close}"

  run_obj="$(jq -nc \
    --arg run "${run_idx}" \
    --arg status "$status" \
    --arg rc "$rc" \
    --arg auction_id "$auction_id" \
    --arg auction_ids "$auction_ids" \
    --arg observer_frames "$observer_frames" \
    --arg observer_read_errors "$observer_read_errors" \
    --arg observer_dial_errors "$observer_dial_errors" \
    --arg bidder_sent "$bidder_sent" \
    --arg bidder_acked "$bidder_acked" \
    --arg bidder_rejected "$bidder_rejected" \
    --arg bidder_errors "$bidder_errors" \
    --arg seq_gap_count "$seq_gap_count" \
    --arg backpressure_force_close "$backpressure_force_close" \
    --arg logfile "$log_file" \
    --arg accept_rate "$load_accept_rate" \
    --arg panic "$panic_present" \
    --arg ts "$ts" \
    '{run: ($run|tonumber), status: $status, rc: ($rc|tonumber), auction_id: $auction_id, auction_ids: ($auction_ids | split(",") | map(select(length > 0))), observer_frames: ($observer_frames|tonumber), observer_read_errors: ($observer_read_errors|tonumber), observer_dial_errors: ($observer_dial_errors|tonumber), bidder_sent: ($bidder_sent|tonumber), bidder_acked: ($bidder_acked|tonumber), bidder_rejected: ($bidder_rejected|tonumber), bidder_errors: ($bidder_errors|tonumber), seq_gap_count: ($seq_gap_count|tonumber), backpressure_force_close: ($backpressure_force_close|tonumber), panic_present: ($panic == "1"), accept_rate: $accept_rate, log: $logfile, timestamp: $ts}')"

  if (( run_idx > 1 )); then
    printf ',' >> "$json_payload"
  fi
  printf '%s\n' "$run_obj" >> "$json_payload"
done

printf ']\n' >> "$json_payload"

if (( CLEAN_LOGS == 1 )); then
  find "$log_dir" -type f -name 'load-smoke-*' -mtime +7 -delete
fi

pass_pct=0
if (( ATTEMPTS > 0 )); then
  pass_pct="$(awk -v p="$pass" -v t="$ATTEMPTS" 'BEGIN { printf "%.1f", (p*100)/t }')"
fi

echo "summary: pass=${pass}/${ATTEMPTS} fail=${failed}/${ATTEMPTS} pass_rate=${pass_pct}%"
echo "totals: observer.readErrors=${total_read_errors}, observer.dialErrors=${total_dial_errors}, panicRuns=${total_panic_runs}, bidder.sent=${total_bid_sents}, bidder.acked=${total_bid_acked}, bidder.rejected=${total_bid_rejected}, bidder.errors=${total_bid_errors}, seqGapCount=${total_seq_gap_count}, backpressureForceClose=${total_backpressure_force_close}"

if (( OUTPUT_JSON == 1 )); then
  jq -cn --arg attempts "$ATTEMPTS" --arg failed "$failed" --arg pass "$pass" \
    --arg pass_pct "$pass_pct" \
    --arg total_read_errors "$total_read_errors" --arg total_dial_errors "$total_dial_errors" \
    --arg total_panic_runs "$total_panic_runs" \
    --arg total_bid_sents "$total_bid_sents" --arg total_bid_acked "$total_bid_acked" \
    --arg total_bid_rejected "$total_bid_rejected" --arg total_bid_errors "$total_bid_errors" \
    --arg total_seq_gap_count "$total_seq_gap_count" \
    --arg total_backpressure_force_close "$total_backpressure_force_close" \
    --rawfile runs "$json_payload" \
    '{attempts: ($attempts|tonumber), pass: ($pass|tonumber), failed: ($failed|tonumber), pass_rate: ($pass_pct|tonumber), totals: {observer_read_errors: ($total_read_errors|tonumber), observer_dial_errors: ($total_dial_errors|tonumber), panic_runs: ($total_panic_runs|tonumber), bidder_sent: ($total_bid_sents|tonumber), bidder_acked: ($total_bid_acked|tonumber), bidder_rejected: ($total_bid_rejected|tonumber), bidder_errors: ($total_bid_errors|tonumber), seq_gap_count: ($total_seq_gap_count|tonumber), backpressure_force_close: ($total_backpressure_force_close|tonumber)}, runs: ($runs|fromjson)}'
fi

if [[ "$CLEANUP_STACK" == "1" ]]; then
  echo ">>> stopping stack (make down)"
  make down
fi

if (( STRICT == 1 && failed > 0 )); then
  exit 1
fi

exit 0
