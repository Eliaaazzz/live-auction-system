#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/smoke-pr103-api.sh [options]

Options:
  --base-url URL    Base URL for backend API (default: http://localhost:8080)
  --up              Start stack via `make up` if healthz is not reachable
  --down            Stop stack after run (only effective when paired with --up)
  -h, --help        Show usage
EOF
}

BASE_URL="http://localhost:8080"
ENSURE_UP=0
TEARDOWN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --up)
      ENSURE_UP=1
      shift
      ;;
    --down)
      TEARDOWN=1
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
      echo "unexpected arg: $1"
      usage
      exit 2
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "required: curl"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi

call_api() {
  local method="$1"
  local path="$2"
  local token="$3"
  local body="${4:-}"

  local response_file
  response_file="$(mktemp)"
  local -a curl_args=(
    -sS
    -o "$response_file"
    -X "$method"
    -H "Content-Type: application/json"
    "${BASE_URL}${path}"
    -w '%{http_code}'
  )

  if [[ -n "$token" ]]; then
    curl_args+=(-H "Authorization: Bearer $token")
  fi
  if [[ -n "$body" ]]; then
    curl_args+=(--data "$body")
  fi

  local status
  status="$(curl "${curl_args[@]}")"
  local payload
  payload="$(cat "$response_file")"

  rm -f "$response_file"
  CALL_STATUS="$status"
  CALL_BODY="$payload"
}

assert_status() {
  local got="$1" want="$2" msg="$3"
  if [[ "$got" -ne "$want" ]]; then
    echo "FAIL: ${msg} (got=$got, want=$want)" >&2
    echo "Response: ${CALL_BODY}" >&2
    exit 1
  fi
}

if ! curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1; then
  if [[ "$ENSURE_UP" == "1" ]]; then
    echo "backend not ready, running make up"
    make up
  else
    echo "backend not ready at ${BASE_URL}/healthz (pass --up or start stack first)"
    exit 1
  fi
fi

if ! curl -sf "${BASE_URL}/healthz" >/dev/null 2>&1; then
  echo "backend failed to become healthy at ${BASE_URL}/healthz"
  exit 1
fi

cleanup() {
  if [[ "$TEARDOWN" == "1" ]]; then
    echo "teardown: make down"
    make down
  fi
}
trap cleanup EXIT

echo "backend ready: ${BASE_URL}"

echo "auth: seed seller and buyer identities"
call_api POST /api/dev-login "" "{\"nickname\":\"seller-pr103-smoke-$(date +%s)\",\"role\":\"seller\"}"
seller_token="$(jq -r '.token // empty' <<<"$CALL_BODY")"
if [[ -z "$seller_token" || "$seller_token" == "null" ]]; then
  echo "FAIL: dev-login failed for seller"
  echo "status=${CALL_STATUS} body=${CALL_BODY}"
  exit 1
fi

call_api POST /api/dev-login "" "{\"nickname\":\"buyer-pr103-smoke-$(date +%s)\",\"role\":\"user\"}"
buyer_token="$(jq -r '.token // empty' <<<"$CALL_BODY")"
if [[ -z "$buyer_token" || "$buyer_token" == "null" ]]; then
  echo "FAIL: dev-login failed for buyer"
  echo "status=${CALL_STATUS} body=${CALL_BODY}"
  exit 1
fi

echo "create product"
call_api POST /api/products "$seller_token" \
  "{\"name\":\"API smoke product $(date +%s)\",\"imageUrl\":\"https://picsum.photos/seed/pr103/320/180\",\"description\":\"smoke test\"}"
product_id="$(jq -r '.productId // empty' <<<"$CALL_BODY")"
if [[ -z "$product_id" || "$product_id" == "null" ]]; then
  echo "FAIL: /api/products did not return productId"
  echo "status=${CALL_STATUS} body=${CALL_BODY}"
  exit 1
fi

echo "create auction"
call_api POST /api/auctions "$seller_token" \
"{\"productId\":\"$product_id\",\"rules\":{\"startPriceCents\":\"100\",\"incrementCents\":\"10\",\"capPriceCents\":\"0\",\"durationSec\":30,\"extendWindowSec\":10,\"extendSec\":10,\"maxExtensions\":2},\"factsConfirmed\":true,\"confirmedFacts\":{}}"
auction_id="$(jq -r '.auctionId // empty' <<<"$CALL_BODY")"
if [[ -z "$auction_id" || "$auction_id" == "null" ]]; then
  echo "FAIL: /api/auctions did not return auctionId"
  echo "status=${CALL_STATUS} body=${CALL_BODY}"
  exit 1
fi

echo "snapshot auction"
call_api GET "/api/auctions/$auction_id" ""
assert_status "$CALL_STATUS" 200 "GET /api/auctions/{id}"
status_value="$(jq -r '.status // empty' <<<"$CALL_BODY")"
if [[ "$status_value" != "DRAFT" && "$status_value" != "LIVE" && "$status_value" != "SCHEDULED" ]]; then
  echo "FAIL: unexpected auction status '$status_value'"
  echo "body=${CALL_BODY}"
  exit 1
fi

echo "events-count"
call_api GET "/api/auctions/$auction_id/events-count" ""
assert_status "$CALL_STATUS" 200 "GET /api/auctions/{id}/events-count"
events_count="$(jq -r '.count // empty' <<<"$CALL_BODY")"
if ! [[ "$events_count" =~ ^[0-9]+$ ]]; then
  echo "FAIL: events-count did not return numeric count"
  echo "body=${CALL_BODY}"
  exit 1
fi

echo "leaderboard auth guard"
call_api GET "/api/auctions/$auction_id/leaderboard?n=5" ""
assert_status "$CALL_STATUS" 401 "GET /api/auctions/{id}/leaderboard no token"
call_api GET "/api/auctions/$auction_id/leaderboard?n=5" "$buyer_token" ""
assert_status "$CALL_STATUS" 200 "GET /api/auctions/{id}/leaderboard with token"

echo "evidence auth guard"
call_api GET "/api/auctions/$auction_id/evidence" ""
assert_status "$CALL_STATUS" 401 "GET /api/auctions/{id}/evidence no token"
call_api GET "/api/auctions/$auction_id/evidence" "$buyer_token" ""
assert_status "$CALL_STATUS" 200 "GET /api/auctions/{id}/evidence with token"
timeline_len="$(jq -r '.eventsCount // empty' <<<"$CALL_BODY")"
if ! [[ "$timeline_len" =~ ^[0-9]+$ ]]; then
  echo "FAIL: evidence payload missing numeric eventsCount"
  echo "body=${CALL_BODY}"
  exit 1
fi

echo "freeze transition (seller only)"
call_api POST "/api/auctions/$auction_id/freeze" "" ""
assert_status "$CALL_STATUS" 401 "POST /api/auctions/{id}/freeze no token"
call_api POST "/api/auctions/$auction_id/freeze" "$seller_token" ""
assert_status "$CALL_STATUS" 200 "POST /api/auctions/{id}/freeze"

echo "API smoke complete: auction=${auction_id}, product=${product_id}"
