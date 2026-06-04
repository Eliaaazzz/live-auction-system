#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}"
BASE_WS_URL="$(printf '%s' "$BASE_WS_URL" | xargs)"
BASE_WS_URL="${BASE_WS_URL%/}"
AID="${AID:-auc_demo}"
REQUIRE_HTTPS="${REQUIRE_HTTPS:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/lumen-deploy-preflight-$(date -u +%Y%m%dT%H%M%SZ)}"
MAX_TIME="${MAX_TIME:-10}"
ALLOW_FAILURE="${ALLOW_FAILURE:-0}"
REQUIRE_WS_UPGRADE="${REQUIRE_WS_UPGRADE:-0}"
REQUIRE_WS_SCHEMA_CHECK="${REQUIRE_WS_SCHEMA_CHECK:-0}"
WS_PRECHECK_AUCTION="${WS_PRECHECK_AUCTION:-$AID}"
WS_PRECHECK_SCHEMA="${WS_PRECHECK_SCHEMA:-${SCHEMA_VERSION:-2}}"
WS_PRECHECK_TOKEN="${WS_PRECHECK_TOKEN:-}"

mkdir -p "$OUT_DIR"

STATUS_FILE="$OUT_DIR/status.tsv"
MANIFEST_FILE="$OUT_DIR/manifest.txt"
METRICS_SUMMARY="$OUT_DIR/metrics-summary.json"

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

normalize_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      echo 1
      ;;
    0|false|no|off)
      echo 0
      ;;
    *)
      echo "$1"
      ;;
    esac
}

is_positive_int() {
  case "$1" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

REQUIRE_WS_UPGRADE="$(normalize_bool "$REQUIRE_WS_UPGRADE")"
REQUIRE_WS_SCHEMA_CHECK="$(normalize_bool "$REQUIRE_WS_SCHEMA_CHECK")"
REQUIRE_HTTPS="$(normalize_bool "$REQUIRE_HTTPS")"
ALLOW_FAILURE="$(normalize_bool "$ALLOW_FAILURE")"
if is_true "$REQUIRE_WS_SCHEMA_CHECK" && ! is_positive_int "$WS_PRECHECK_SCHEMA"; then
  echo "invalid WS_PRECHECK_SCHEMA=$WS_PRECHECK_SCHEMA; must be positive integer when REQUIRE_WS_SCHEMA_CHECK=1"
  exit 1
fi
if [ -z "$WS_PRECHECK_AUCTION" ]; then
  echo "invalid WS_PRECHECK_AUCTION: auction id required"
  exit 1
fi

printf "check\texit_code\thttp_code\tartifact\n" > "$STATUS_FILE"

failures=0

ws_url="$BASE_WS_URL"
case "$ws_url" in
  https://*) ws_url="wss://${ws_url#https://}" ;;
  http://*) ws_url="ws://${ws_url#http://}" ;;
esac

{
  echo "lumen deploy preflight"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_url=$BASE_URL"
  echo "base_ws_url=$BASE_WS_URL"
  echo "derived_ws_url=$ws_url/ws"
  echo "auction_id=$AID"
  echo "out_dir=$OUT_DIR"
  echo "max_time=$MAX_TIME"
  echo "require_https=$REQUIRE_HTTPS"
  if command -v git >/dev/null 2>&1; then
    echo "git_head=$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
    echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
  fi
  echo "require_ws_upgrade=$REQUIRE_WS_UPGRADE"
  echo "require_ws_schema_check=$REQUIRE_WS_SCHEMA_CHECK"
  echo "ws_precheck_schema=$WS_PRECHECK_SCHEMA"
  echo "ws_precheck_auction=$WS_PRECHECK_AUCTION"
  echo "ws_precheck_token_set=$([ -n "${WS_PRECHECK_TOKEN:-}" ] && echo true || echo false)"
  echo
  echo "This preflight reads public endpoints and does not inspect secrets."
} > "$MANIFEST_FILE"

record_http() {
  local name="$1"
  local path="$2"
  local want_prefix="$3"
  local dir="$OUT_DIR/$name"
  local url="$BASE_URL$path"
  local rc
  local http_code

  mkdir -p "$dir"
  echo "==> $name $url"

  set +e
  http_code="$(curl -sS -L --max-time "$MAX_TIME" \
    -D "$dir/headers.txt" \
    -o "$dir/body.txt" \
    -w "%{http_code}" \
    "$url" 2>"$dir/stderr.txt")"
  rc=$?
  set -e

  printf "%s\t%d\t%s\t%s\n" "$name" "$rc" "$http_code" "$dir" >> "$STATUS_FILE"

  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> $name curl failed with exit code $rc"
    return
  fi

  case "$http_code" in
    "$want_prefix"*) ;;
    *)
      failures=$((failures + 1))
      echo "==> $name expected HTTP ${want_prefix}xx, got $http_code"
      ;;
  esac
}

record_ws_schema() {
  local name="$1"
  local dir="$OUT_DIR/$name"
  local expected_schema="$2"
  local auction="$3"
  local token="${4:-}"
  local timeout_ms
  local rc

  mkdir -p "$dir"

  if ! command -v node >/dev/null 2>&1; then
    failures=$((failures + 1))
    printf "%s\t1\t-\t%s\n" "$name" "$dir" >> "$STATUS_FILE"
    echo "==> $name requires node runtime, but node not found"
    return
  fi

  if [ ! -f "$SCRIPT_DIR/ws-schema-precheck.mjs" ]; then
    failures=$((failures + 1))
    printf "%s\t1\t-\t%s\n" "$name" "$dir" >> "$STATUS_FILE"
    echo "==> $name missing script: $SCRIPT_DIR/ws-schema-precheck.mjs"
    return
  fi

  timeout_ms="$((MAX_TIME * 1000))"
  if [ -z "$timeout_ms" ] || [ "$timeout_ms" -le 0 ]; then
    timeout_ms=8000
  fi

  set +e
  if [ -n "$token" ]; then
    node "$SCRIPT_DIR/ws-schema-precheck.mjs" \
      --url "$ws_url" \
      --auction "$auction" \
      --schema "$expected_schema" \
      --token "$token" \
      --timeout-ms "$timeout_ms" \
      > "$dir/stdout.txt" \
      2> "$dir/stderr.txt"
  else
    node "$SCRIPT_DIR/ws-schema-precheck.mjs" \
      --url "$ws_url" \
      --auction "$auction" \
      --schema "$expected_schema" \
      --timeout-ms "$timeout_ms" \
      > "$dir/stdout.txt" \
      2> "$dir/stderr.txt"
  fi
  rc=$?
  set -e

  printf "%s\t%d\t%s\t%s\n" "$name" "$rc" "-" "$dir" >> "$STATUS_FILE"

  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> $name schema precheck failed; inspect $dir/stderr.txt"
    if [ -n "${WS_PRECHECK_TOKEN:-}" ] && [ -s "$dir/stderr.txt" ]; then
      sed -n '1,5p' "$dir/stderr.txt"
    elif [ -s "$dir/stdout.txt" ]; then
      sed -n '1,5p' "$dir/stdout.txt"
    fi
    return
  fi

  echo "==> $name schema check passed for auction=$auction expected=$expected_schema"
}

check_https() {
  if is_true "$REQUIRE_HTTPS" && [[ "$BASE_URL" != https://* ]]; then
    failures=$((failures + 1))
    printf "%s\t%d\t%s\t%s\n" "require_https" "1" "-" "$OUT_DIR" >> "$STATUS_FILE"
    echo "==> REQUIRE_HTTPS=1 but BASE_URL is not https: $BASE_URL"
    return 1
  fi

  printf "%s\t%d\t%s\t%s\n" "require_https" "0" "-" "$OUT_DIR" >> "$STATUS_FILE"
  return 0
}

record_ws() {
  local name="$1"
  local path="$2"
  local mode="$3"
  local url="$BASE_URL$path"
  local dir="$OUT_DIR/$name"
  local token="${WS_PRECHECK_TOKEN:-}"
  local expected_code_1xx="401"
  local expected_code_2xx="403"
  local expected_upgrade="0"
  local allow_ws_upgrade="0"
  local rc
  local http_code

  mkdir -p "$dir"

  if is_true "$mode"; then
    expected_code_1xx="101"
    expected_code_2xx=""
    expected_upgrade="1"
    allow_ws_upgrade="1"
    if [ -z "$token" ]; then
      echo "==> WS_PRECHECK_TOKEN is empty; fallback to auth-gate check (401)"
      expected_code_1xx="401"
      expected_code_2xx="403"
      expected_upgrade="0"
      mode="0"
    fi
  elif [ -n "$token" ]; then
    allow_ws_upgrade="1"
  fi

  if [ -n "$token" ]; then
    if printf '%s' "$path" | grep -q '?'; then
      url="${url}&token=${token}"
    else
      url="${url}?token=${token}"
    fi
  fi

  echo "==> $name $url"

  set +e
  http_code="$(curl -sS --max-time "$MAX_TIME" \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    --http1.1 \
    -D "$dir/headers.txt" \
    -o "$dir/body.txt" \
    -w '%{http_code}' \
    "$url" 2>"$dir/stderr.txt")"
  rc=$?
  set -e

  printf "%s\t%d\t%s\t%s\n" "$name" "$rc" "$http_code" "$dir" >> "$STATUS_FILE"

  # Some websocket servers keep the upgraded connection open; curl can still be
  # terminated by --max-time (28). If we already got the expected success code,
  # treat that as success.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 28 ]; then
    failures=$((failures + 1))
    echo "==> $name curl failed with exit code $rc"
    return
  fi

  local is_expected=0
  if [ "$http_code" = "$expected_code_1xx" ]; then
    is_expected=1
  elif [ -n "$expected_code_2xx" ] && [ "$http_code" = "$expected_code_2xx" ]; then
    is_expected=1
  elif [ "$allow_ws_upgrade" = "1" ] && [ "$http_code" = "101" ]; then
    is_expected=1
  fi

  if [ "$is_expected" -ne 1 ]; then
    if [ "$rc" -eq 28 ] && [ "$expected_upgrade" = "1" ] && grep -q '^HTTP/.* 101 ' "$dir/headers.txt" 2>/dev/null; then
      return
    fi
    failures=$((failures + 1))
    if [ "$expected_code_1xx" = "101" ]; then
      echo "==> $name expected websocket upgrade 101, got ${http_code}"
    elif [ "$allow_ws_upgrade" = "1" ]; then
      echo "==> $name expected HTTP ${expected_code_1xx}/${expected_code_2xx}/101, got ${http_code}"
    else
      echo "==> $name expected HTTP ${expected_code_1xx}/${expected_code_2xx}, got ${http_code}"
    fi
    return
  fi

  if [ "$rc" -eq 28 ] && ! grep -q "^HTTP/.* ${http_code} " "$dir/headers.txt" 2>/dev/null; then
    failures=$((failures + 1))
    echo "==> $name exited by timeout before ws handshake/auth response"
  fi
}

record_http "healthz" "/healthz" "2"
record_http "metrics" "/metrics" "2"
record_http "admin" "/admin.html" "2"
record_http "room" "/room.html?auction=$AID" "2"
record_ws "ws" "/ws" "$REQUIRE_WS_UPGRADE"
check_https
if is_true "$REQUIRE_WS_SCHEMA_CHECK"; then
  record_ws_schema "ws_schema" "$WS_PRECHECK_SCHEMA" "$WS_PRECHECK_AUCTION" "$WS_PRECHECK_TOKEN"
else
  printf "%s\t%d\t%s\t%s\n" "ws_schema" "0" "-" "$OUT_DIR" >> "$STATUS_FILE"
fi

if [ -s "$OUT_DIR/metrics/body.txt" ]; then
  if command -v jq >/dev/null 2>&1; then
    jq '{activeConns, ackLatencyMs, broadcastLatencyMs, seqGapCount, backpressureForceClose}' \
      "$OUT_DIR/metrics/body.txt" > "$METRICS_SUMMARY" 2>/dev/null || true
  else
    cp "$OUT_DIR/metrics/body.txt" "$METRICS_SUMMARY"
  fi
fi

{
  echo
  echo "status_file=$STATUS_FILE"
  echo "metrics_summary=$METRICS_SUMMARY"
  echo "failed_checks=$failures"
  echo "room_url=$BASE_URL/room.html?auction=$AID"
} >> "$MANIFEST_FILE"

echo "preflight pack:  $OUT_DIR"
echo "manifest:        $MANIFEST_FILE"
echo "status:          $STATUS_FILE"
echo "metrics summary: $METRICS_SUMMARY"

if [ "$failures" -ne 0 ] && ! is_true "$ALLOW_FAILURE"; then
  exit 1
fi
