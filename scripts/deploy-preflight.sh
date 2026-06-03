#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
AID="${AID:-auc_demo}"
OUT_DIR="${OUT_DIR:-/tmp/lumen-deploy-preflight-$(date -u +%Y%m%dT%H%M%SZ)}"
MAX_TIME="${MAX_TIME:-10}"
ALLOW_FAILURE="${ALLOW_FAILURE:-0}"

mkdir -p "$OUT_DIR"

STATUS_FILE="$OUT_DIR/status.tsv"
MANIFEST_FILE="$OUT_DIR/manifest.txt"
METRICS_SUMMARY="$OUT_DIR/metrics-summary.json"

printf "check\texit_code\thttp_code\tartifact\n" > "$STATUS_FILE"

failures=0

ws_url="$BASE_URL"
case "$ws_url" in
  https://*) ws_url="wss://${ws_url#https://}" ;;
  http://*) ws_url="ws://${ws_url#http://}" ;;
esac

{
  echo "lumen deploy preflight"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_url=$BASE_URL"
  echo "derived_ws_url=$ws_url/ws"
  echo "auction_id=$AID"
  echo "out_dir=$OUT_DIR"
  echo "max_time=$MAX_TIME"
  if command -v git >/dev/null 2>&1; then
    echo "git_head=$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
    echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
  fi
  echo
  echo "This preflight reads only public HTTP endpoints and does not inspect secrets."
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

record_ws() {
  local name="$1"
  local path="$2"
  local url="$BASE_URL$path"
  local dir="$OUT_DIR/$name"
  local rc
  local http_code

  mkdir -p "$dir"
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
  # terminated by --max-time (28). If we already got 101, treat that as success.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 28 ]; then
    failures=$((failures + 1))
    echo "==> $name curl failed with exit code $rc"
    return
  fi

  if [ "$http_code" != "101" ]; then
    if [ "$rc" -eq 28 ] && grep -q '^HTTP/.* 101 ' "$dir/headers.txt" 2>/dev/null; then
      return
    fi
    failures=$((failures + 1))
    echo "==> $name expected HTTP 101 websocket upgrade, got ${http_code}"
    return
  fi

  if [ "$rc" -eq 28 ] && ! grep -q '^HTTP/.* 101 ' "$dir/headers.txt" 2>/dev/null; then
    failures=$((failures + 1))
    echo "==> $name exited by timeout before ws upgrade"
  fi
}

record_http "healthz" "/healthz" "2"
record_http "metrics" "/metrics" "2"
record_http "admin" "/admin.html" "2"
record_http "room" "/room.html?auction=$AID" "2"
record_ws "ws" "/ws" 

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

if [ "$failures" -ne 0 ] && [ "$ALLOW_FAILURE" != "1" ]; then
  exit 1
fi
