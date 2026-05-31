#!/usr/bin/env bash
# k6-setup.sh — pre-stage helper for the k6 stress test.
#
# Pre-stages N buyer dev-login tokens + creates one tuned auction. k6's
# setup() stage doesn't scale well for 5k REST calls (each VU would re-do
# the work), so we do it once here and write tokens to a file the k6
# scenarios load via k6/data SharedArray.
#
# Run before `make k6` or `k6 run tools/loadtest/k6-ws.js`.
#
# Usage:
#   N_USERS=5000 ./tools/loadtest/k6-setup.sh
#
# Output files (gitignored):
#   .k6-tokens  — one JWT per line; written via per-PID temp files +
#                 cat-merge so concurrent appenders can't interleave.
#                 (POSIX `>>` is not atomic past PIPE_BUF=4KiB; a parallel
#                 token stream where each line is ~80B can survive but is
#                 brittle on MSYS / large parallelism.)
#   .k6-aid     — the auction id this load run will target
set -euo pipefail

TARGET="${TARGET:-http://localhost:8080}"
N="${N_USERS:-5000}"
PARALLEL="${PARALLEL:-50}"
DURATION_SEC="${LOAD_AUCTION_DUR_SEC:-3600}"
TMP_DIR=".k6-tokens.tmp"

echo "[k6-setup] target=$TARGET users=$N auctionDur=${DURATION_SEC}s parallel=$PARALLEL"

login() {
  local nick="$1" role="$2" out="$3"
  curl -s -X POST "$TARGET/api/dev-login" \
    -H 'content-type: application/json' \
    -d "{\"nickname\":\"$nick\",\"role\":\"$role\"}" \
    | python -c 'import json,sys; d=json.load(sys.stdin); print(d["token"])' \
    >> "$out"
}

# 1) Seller + auction setup. Increment=1, no cap, no anti-snipe so every
# strictly-increasing bid is acceptable (we're measuring concurrency, not
# adjudication).
SELLER_TOKEN=$(curl -s -X POST "$TARGET/api/dev-login" \
  -H 'content-type: application/json' \
  -d "{\"nickname\":\"k6-seller-$$\",\"role\":\"seller\"}" \
  | python -c 'import json,sys; d=json.load(sys.stdin); print(d["token"])')

PRODUCT_ID=$(curl -s -X POST "$TARGET/api/products" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"k6 stress watch","imageUrl":"https://example.com/w.jpg","description":"k6"}' \
  | python -c 'import json,sys; d=json.load(sys.stdin); print(d["productId"])')

AID=$(curl -s -X POST "$TARGET/api/auctions" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"productId\":\"$PRODUCT_ID\",\"factsConfirmed\":true,\"rules\":{\"startPriceCents\":100000,\"incrementCents\":1,\"capPriceCents\":0,\"durationSec\":$DURATION_SEC,\"extendWindowSec\":0,\"extendSec\":0}}" \
  | python -c 'import json,sys; d=json.load(sys.stdin); print(d["auctionId"])')

curl -s -X POST "$TARGET/api/auctions/$AID/freeze" -H "Authorization: Bearer $SELLER_TOKEN" >/dev/null
curl -s -X POST "$TARGET/api/auctions/$AID/start"  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"durationMs\":$((DURATION_SEC*1000))}" >/dev/null

echo "$AID" > .k6-aid
echo "[k6-setup] auction LIVE: $AID"

# 2) Pre-stage N buyer tokens. Per-batch temp files + cat-merge avoids the
# "parallel >> on one file" race that previously corrupted ~80% of tokens
# (5000 issued → 1141 valid after grep, with several lines concatenated).
echo "[k6-setup] dev-logging $N buyers ($PARALLEL parallel, per-batch temp files)..."
rm -rf "$TMP_DIR" && mkdir -p "$TMP_DIR"
i=0
while [ $i -lt "$N" ]; do
  batch_end=$((i + PARALLEL))
  [ $batch_end -gt "$N" ] && batch_end=$N
  # Each parallel login writes to its OWN temp file → no append race.
  for ((j=i; j<batch_end; j++)); do
    login "k6-buyer-$j" user "$TMP_DIR/$j.tok" &
  done
  wait
  i=$batch_end
  if [ $((i % 500)) -eq 0 ]; then echo "[k6-setup]   logged in $i/$N"; fi
done

# Merge — concatenation is safe (one file = one valid token, no partial writes).
# Filter to canonical token shape to drop any pathological empty lines.
cat "$TMP_DIR"/*.tok 2>/dev/null \
  | grep -E '^user_k6_buyer_[0-9]+\.[a-f0-9]{64}$' \
  > .k6-tokens
rm -rf "$TMP_DIR"

ACTUAL=$(wc -l < .k6-tokens)
echo "[k6-setup] done · AID=$AID · tokens=$ACTUAL (expected $N)"
if [ "$ACTUAL" -lt "$N" ]; then
  echo "[k6-setup] WARN: $((N - ACTUAL)) tokens missing (network blips during login). Continuing — k6 wraps via modulo."
fi
