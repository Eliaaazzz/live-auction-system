#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify-second-price-payment.sh --pack-dir PATH [options]

  scripts/verify-second-price-payment.sh --auction-id ID[,ID...] [options]

Options:
  --pack-dir PATH            directory containing rehearsal outputs (summary.tsv / manifest.json)
  --summary PATH             summary.tsv path (default: <pack-dir>/summary.tsv)
  --auction-id ID[,ID...]    verify one or more auction IDs explicitly (comma separated), override pack input
  --base-url URL             API base URL (default: http://localhost:8080)
  --token TOKEN              JWT for evidence endpoint authentication (optional)
  --token-file FILE          file that contains token (optional)
  --report PATH              write TSV report to this path (optional)
  --strict-chain             fail if evidence.chainVerified != true (default)
  --no-strict-chain          do not fail on chainVerified=false
  --allow-chain-failed        alias for --no-strict-chain
  -h, --help                 show this help
USAGE
}

trim() {
  printf '%s' "$1" | xargs
}

is_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

normalize_mode() {
  local mode
  mode="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' '_' | tr '-' '_')"
  case "$mode" in
    ""|"first"|"first_price"|"firstprice")
      printf 'first_price'
      ;;
    "second"|"second_price"|"secondprice"|"vickrey"|"auction2"|"2")
      printf 'second_price'
      ;;
    *)
      printf '%s' "$mode"
      ;;
  esac
}

fetch_json() {
  local path="$1"
  local out_var="$2"
  local url="$BASE_URL$path"
  local tmp_body code rc body
  local -a curl_cmd

  tmp_body="$(mktemp)"
  curl_cmd=(curl -sS -L --max-time "${VERIFY_SECOND_PRICE_PAYMENT_TIMEOUT:-10}" -w '%{http_code}' -o "$tmp_body")
  if [[ -n "$TOKEN" ]]; then
    curl_cmd+=(-H "Authorization: Bearer $TOKEN")
  fi

  set +e
  code="$("${curl_cmd[@]}" "$url")"
  rc=$?
  set -e

  if [[ "$rc" != "0" ]]; then
    rm -f "$tmp_body"
    return 1
  fi
  if [[ "$code" != "200" ]]; then
    printf -v "$out_var" ''
    rm -f "$tmp_body"
    return 1
  fi

  body="$(cat "$tmp_body")"
  rm -f "$tmp_body"
  printf -v "$out_var" '%s' "$body"
  return 0
}

append_target_id() {
  local raw
  for raw in "$@"; do
    raw="$(trim "$raw")"
    if [[ -z "$raw" ]]; then
      continue
    fi
    if [[ -z "${TARGET_SEEN[$raw]+x}" ]]; then
      TARGET_SEEN["$raw"]=1
      TARGET_AUCTIONS+=("$raw")
    fi
  done
}

append_csv_targets() {
  local csv="$1"
  local IFS=','
  local entry
  local -a entries

  read -ra entries <<< "$csv"
  for entry in "${entries[@]}"; do
    append_target_id "$entry"
  done
}

emit_row() {
  local row="$1"
  echo "$row"
  if [[ -n "$REPORT_PATH" ]]; then
    echo "$row" >> "$REPORT_PATH"
  fi
}

check_auction_payment() {
  local aid="$1"
  local snapshot evidence
  local mode raw_mode reserve start fallback
  local sold_amount expected_payment
  local -A top_by_user=()
  local -a sorted_amounts
  local -i bid_user_count=0
  local bid_rows

  if ! fetch_json "/api/auctions/$aid" snapshot; then
    ((skipped_count+=1))
    emit_row "$aid\tSKIP\t-\t-\t-\t-\tunable to fetch /api/auctions/$aid (may need BASE_URL or network)"
    return 0
  fi

  raw_mode="$(jq -r '.rules.auctionMode // .rules.mode // .mode // .auctionMode // empty' <<<"$snapshot")"
  if [[ -z "$raw_mode" ]]; then
    ((skipped_count+=1))
    emit_row "$aid\tSKIP\t-\t-\t-\t-\tmissing auctionMode/mode in snapshot"
    return 0
  fi
  mode="$(normalize_mode "$raw_mode")"
  if [[ "$mode" != "second_price" ]]; then
    ((skipped_count+=1))
    emit_row "$aid\tSKIP\t-\t-\t$mode\t-\tnon-second-price mode in snapshot"
    return 0
  fi

  reserve="$(jq -r '.rules.reserveCents // empty' <<<"$snapshot")"
  start="$(jq -r '.rules.startPriceCents // empty' <<<"$snapshot")"
  current="$(jq -r '.currentPriceCents // empty' <<<"$snapshot")"
  if ! is_non_negative_int "$reserve"; then
    reserve="0"
  fi
  if ! is_non_negative_int "$start"; then
    start="0"
  fi
  if ! is_non_negative_int "$current"; then
    current="0"
  fi
  fallback="$reserve"
  if [[ "$fallback" == "0" ]]; then
    fallback="$start"
  fi
  if [[ "$fallback" == "0" ]]; then
    fallback="$current"
  fi

  if [[ -z "$TOKEN" ]]; then
    ((skipped_count+=1))
    emit_row "$aid\tSKIP\t-\t-\t$mode\t$fallback\tmissing token for /api/auctions/$aid/evidence"
    return 0
  fi

  if ! fetch_json "/api/auctions/$aid/evidence" evidence; then
    ((skipped_count+=1))
    emit_row "$aid\tSKIP\t-\t-\t$mode\t$fallback\tunable to fetch /api/auctions/$aid/evidence with token"
    return 0
  fi

  if [[ "$STRICT_CHAIN" == "1" && "$(jq -r '.chainVerified // false' <<<"$evidence")" != "true" ]]; then
    ((fail_count+=1))
    emit_row "$aid\tFAIL\t-\t-\t$mode\t$fallback\tchainVerified != true"
    return 0
  fi

  sold_amount="$(jq -r '[.timeline[]? | select(.eventType=="AUCTION_SOLD") | .payload.amountCents // empty][(-1)] // empty' <<<"$evidence")"
  if [[ -z "$sold_amount" ]]; then
    ((skipped_count+=1))
    emit_row "$aid\tSKIP\t-\t-\t$mode\t$fallback\tno AUCTION_SOLD event in evidence"
    return 0
  fi
  if ! is_non_negative_int "$sold_amount"; then
    ((fail_count+=1))
    emit_row "$aid\tFAIL\t-\t$sold_amount\t$mode\t$fallback\tAUCTION_SOLD amount is non-numeric"
    return 0
  fi

  bid_rows="$(jq -r '.timeline[]? | select(.eventType=="BID_ACCEPTED") | .payload.userId + "\t" + (.payload.amountCents // "")' <<<"$evidence")"
  if [[ -n "$bid_rows" ]]; then
    while IFS=$'\t' read -r user amount; do
      user="$(trim "$user")"
      amount="$(trim "$amount")"
      if [[ -z "$user" || -z "$amount" ]]; then
        continue
      fi
      if ! is_non_negative_int "$amount"; then
        ((fail_count+=1))
        emit_row "$aid\tFAIL\t-\t$sold_amount\t$mode\t$fallback\tBID_ACCEPTED amount non-numeric: $amount"
        return 0
      fi
      if [[ -z "${top_by_user[$user]+x}" || "$amount" -gt "${top_by_user[$user]}" ]]; then
        top_by_user["$user"]="$amount"
      fi
    done <<< "$bid_rows"
  fi

  bid_user_count="${#top_by_user[@]}"
  if (( bid_user_count >= 2 )); then
    mapfile -t sorted_amounts < <(printf '%s\n' "${top_by_user[@]}" | sort -nr)
    expected_payment="${sorted_amounts[1]}"
  else
    expected_payment="$fallback"
  fi

  if ! is_non_negative_int "$expected_payment"; then
    ((fail_count+=1))
    emit_row "$aid\tFAIL\t-\t$sold_amount\t$mode\t$fallback\texpected payment not numeric"
    return 0
  fi

  if [[ "$sold_amount" == "$expected_payment" ]]; then
    ((pass_count+=1))
    emit_row "$aid\tPASS\t$expected_payment\t$sold_amount\t$mode\t$fallback\twinner pay matches rule"
    return 0
  fi

  ((fail_count+=1))
  emit_row "$aid\tFAIL\t$expected_payment\t$sold_amount\t$mode\t$fallback\twinner pay mismatch"
}

PACK_DIR=""
SUMMARY_PATH=""
BASE_URL="${BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
TOKEN="${TOKEN:-${VERIFY_SECOND_PRICE_PAYMENT_TOKEN:-}}"
TOKEN_FILE="${TOKEN_FILE:-${VERIFY_SECOND_PRICE_PAYMENT_TOKEN_FILE:-}}"
AUCTION_IDS=""
REPORT_PATH=""
STRICT_CHAIN="1"

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pack-dir)
      PACK_DIR="$2"
      shift 2
      ;;
    --summary)
      SUMMARY_PATH="$2"
      shift 2
      ;;
    --auction-id|--auction-ids)
      AUCTION_IDS="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="$2"
      BASE_URL="${BASE_URL%/}"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --token-file)
      TOKEN_FILE="$2"
      shift 2
      ;;
    --report)
      REPORT_PATH="$2"
      shift 2
      ;;
    --strict-chain)
      STRICT_CHAIN="1"
      shift
      ;;
    --no-strict-chain|--allow-chain-failed)
      STRICT_CHAIN="0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$PACK_DIR" ]] && [[ -z "$AUCTION_IDS" ]]; then
  echo "error: --pack-dir or --auction-id is required" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "error: required commands curl and jq" >&2
  exit 2
fi

if [[ -n "$TOKEN_FILE" ]]; then
  if [[ ! -f "$TOKEN_FILE" ]]; then
    echo "error: token file not found: $TOKEN_FILE" >&2
    exit 2
  fi
  TOKEN="$(trim "$(cat "$TOKEN_FILE")")"
fi

if [[ -z "$SUMMARY_PATH" ]] && [[ -n "$PACK_DIR" ]]; then
  SUMMARY_PATH="$PACK_DIR/summary.tsv"
fi

if [[ -n "$PACK_DIR" ]] && [[ ! -d "$PACK_DIR" ]] && [[ -z "$SUMMARY_PATH" || ! -f "$SUMMARY_PATH" ]]; then
  echo "error: pack directory not found: $PACK_DIR" >&2
  exit 2
fi

if [[ -n "$PACK_DIR" ]] && [[ -d "$PACK_DIR" ]] && [[ ! -f "$SUMMARY_PATH" ]]; then
  latest_pack="$(ls -1dt "$PACK_DIR"/*/ 2>/dev/null | sed -n '1p' || true)"
  if [[ -n "$latest_pack" ]]; then
    latest_pack="${latest_pack%/}"
    if [[ -f "$latest_pack/summary.tsv" ]]; then
      SUMMARY_PATH="$latest_pack/summary.tsv"
    fi
  fi
fi

if [[ -n "$SUMMARY_PATH" ]] && [[ ! -f "$SUMMARY_PATH" ]] && [[ -z "$AUCTION_IDS" ]]; then
  echo "error: summary not found: $SUMMARY_PATH" >&2
  exit 2
fi

if [[ -n "$REPORT_PATH" ]]; then
  mkdir -p "$(dirname "$REPORT_PATH")"
  : > "$REPORT_PATH"
fi

declare -A TARGET_SEEN=()
declare -a TARGET_AUCTIONS=()

if [[ -n "$AUCTION_IDS" ]]; then
  append_csv_targets "$AUCTION_IDS"
else
  read -r summary_header < "$SUMMARY_PATH"
  summary_header="${summary_header//$'\r'/}"
  summary_header="${summary_header#$'\xef\xbb\xbf'}"
  if [[ "$summary_header" == "#run"* ]]; then
    IFS=$'\t' read -r -a header_cols <<< "$summary_header"
    idx_run=-1
    idx_auction_id=-1
    idx_auction_ids=-1
    idx_auction_mode=-1

    for i in "${!header_cols[@]}"; do
      header_cols[$i]="$(trim "${header_cols[$i]}")"
      case "${header_cols[$i]}" in
        run) idx_run="$i" ;;
        auction_id) idx_auction_id="$i" ;;
        auction_ids) idx_auction_ids="$i" ;;
        auction_mode|mode|auctionMode) [[ "$idx_auction_mode" == "-1" ]] && idx_auction_mode="$i" ;;
      esac
    done

    if (( idx_auction_id < 0 || idx_auction_ids < 0 || idx_auction_mode < 0 || idx_run < 0 )); then
      echo "error: summary header missing required columns" >&2
      exit 2
    fi

    while IFS=$'\t' read -r -a row; do
      if (( ${#row[@]} == 0 )); then
        continue
      fi
      _run="${row[$idx_run]:-}"
      _run="${_run//$'\r'/}"
      if [[ "$_run" == "#run" || -z "$_run" ]]; then
        continue
      fi
      auction_id="$(trim "${row[$idx_auction_id]:-}")"
      auction_ids="$(trim "${row[$idx_auction_ids]:-}")"
      auction_mode="$(trim "${row[$idx_auction_mode]:-}")"
      if [[ -z "$auction_id" ]]; then
        continue
      fi
      if [[ "$(normalize_mode "$auction_mode")" != "second_price" ]]; then
        continue
      fi
      append_target_id "$auction_id"
      append_csv_targets "$auction_ids"
    done < <(tail -n +2 "$SUMMARY_PATH")
  else
    while IFS=$'\t' read -r _run _status _rc _run_dir _log_file _metrics_file auction_id auction_ids auction_mode _rest; do
      if [[ "$_run" == "#run" || -z "$_run" ]]; then
        continue
      fi
      if [[ "$(normalize_mode "$auction_mode")" != "second_price" ]]; then
        continue
      fi
      append_target_id "$auction_id"
      append_csv_targets "$auction_ids"
    done < "$SUMMARY_PATH"
  fi
fi

if (( ${#TARGET_AUCTIONS[@]} == 0 )); then
  echo "PASS (no second-price auction target found)"
  if [[ -n "$REPORT_PATH" ]]; then
    echo "result=PASS" > "$REPORT_PATH"
  fi
  exit 0
fi

pass_count=0
fail_count=0
skipped_count=0

emit_row "auction_id\tresult\texpected_cents\tactual_cents\tauction_mode\tfallback_cents\treason"
for aid in "${TARGET_AUCTIONS[@]}"; do
  if [[ -z "$aid" ]]; then
    continue
  fi
  check_auction_payment "$aid"
done

if (( fail_count > 0 )); then
  echo "result=FAIL pass=$pass_count fail=$fail_count skipped=$skipped_count total=${#TARGET_AUCTIONS[@]}"
  if [[ -n "$REPORT_PATH" ]]; then
    echo "result=FAIL pass=$pass_count fail=$fail_count skipped=$skipped_count total=${#TARGET_AUCTIONS[@]}" >> "$REPORT_PATH"
  fi
  exit 1
fi

echo "result=PASS pass=$pass_count fail=$fail_count skipped=$skipped_count total=${#TARGET_AUCTIONS[@]}"
if [[ -n "$REPORT_PATH" ]]; then
  echo "result=PASS pass=$pass_count fail=$fail_count skipped=$skipped_count total=${#TARGET_AUCTIONS[@]}" >> "$REPORT_PATH"
fi
