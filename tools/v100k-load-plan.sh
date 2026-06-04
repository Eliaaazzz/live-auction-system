#!/usr/bin/env bash
set -eu

# Generate sharded load-agent commands for a 100k connected-user rehearsal.
#
# The existing `lumen load` harness is still the executor. This planner only
# splits observers/bidders across load agents and forces all shards to reuse the
# same LIVE auction via LOAD_AUCTION_ID. By default, only shard 0 bids; the rest
# are observer-only fanout pressure. That avoids independent shard-local amount
# counters fighting each other and turning the run into rejection noise.

die() {
  printf 'v100k-load-plan: %s\n' "$*" >&2
  exit 1
}

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

require_uint() {
  name="$1"
  value="$2"
  is_uint "$value" || die "$name must be a non-negative integer, got '$value'"
}

ceil_div() {
  n="$1"
  d="$2"
  printf '%s\n' $(((n + d - 1) / d))
}

TOTAL_OBSERVERS=${TOTAL_OBSERVERS:-100000}
TOTAL_BIDDERS=${TOTAL_BIDDERS:-100}
SHARDS=${SHARDS:-20}
ACTIVE_SHARDS=${ACTIVE_SHARDS:-1}
LOAD_DURATION_SEC=${LOAD_DURATION_SEC:-60}
LOAD_BID_INTERVAL_MS=${LOAD_BID_INTERVAL_MS:-100}
LOAD_AUCTION_DUR_SEC=${LOAD_AUCTION_DUR_SEC:-7200}
LOAD_OBSERVER_STAGGER_MS=${LOAD_OBSERVER_STAGGER_MS:-1}
LOAD_START_CENTS=${LOAD_START_CENTS:-100000}
TARGET=${TARGET:-http://lumen:8080}
LOAD_AUCTION_ID=${LOAD_AUCTION_ID:-}

require_uint TOTAL_OBSERVERS "$TOTAL_OBSERVERS"
require_uint TOTAL_BIDDERS "$TOTAL_BIDDERS"
require_uint SHARDS "$SHARDS"
require_uint ACTIVE_SHARDS "$ACTIVE_SHARDS"
require_uint LOAD_DURATION_SEC "$LOAD_DURATION_SEC"
require_uint LOAD_BID_INTERVAL_MS "$LOAD_BID_INTERVAL_MS"
require_uint LOAD_AUCTION_DUR_SEC "$LOAD_AUCTION_DUR_SEC"
require_uint LOAD_OBSERVER_STAGGER_MS "$LOAD_OBSERVER_STAGGER_MS"
require_uint LOAD_START_CENTS "$LOAD_START_CENTS"

[ "$SHARDS" -gt 0 ] || die "SHARDS must be > 0"
[ "$ACTIVE_SHARDS" -eq 1 ] || die "ACTIVE_SHARDS must stay 1 until the load harness has a global bid allocator"
[ "$TOTAL_BIDDERS" -gt 0 ] || die "TOTAL_BIDDERS must be > 0 for the active shard"

base_observers=$((TOTAL_OBSERVERS / SHARDS))
extra_observers=$((TOTAL_OBSERVERS % SHARDS))
active_bidders=$(ceil_div "$TOTAL_BIDDERS" "$ACTIVE_SHARDS")

cat <<EOF
# Lumen v100k sharded load rehearsal plan
# target:          $TARGET
# auction:         ${LOAD_AUCTION_ID:-<set LOAD_AUCTION_ID after setup>}
# total observers: $TOTAL_OBSERVERS
# total bidders:   $TOTAL_BIDDERS
# shards:          $SHARDS
# duration:        ${LOAD_DURATION_SEC}s
#
# Setup, if LOAD_AUCTION_ID is not already known:
docker compose -f infra/docker-compose.yml --profile tools run --no-deps --rm --build \\
  -e TARGET="$TARGET" \\
  -e LOAD_OBSERVERS=1 \\
  -e LOAD_BIDDERS=1 \\
  -e LOAD_DURATION_SEC=1 \\
  -e LOAD_AUCTION_DUR_SEC=$LOAD_AUCTION_DUR_SEC \\
  load
#
# Copy LOAD_AUCTION_ID=<auc_...> from setup output, then run one command per
# load-agent host. Start observer-only shards first, then shard 0, so every
# observer is connected before the active bidder shard drives broadcasts.
EOF

for i in $(seq 0 $((SHARDS - 1))); do
  observers=$base_observers
  if [ "$i" -lt "$extra_observers" ]; then
    observers=$((observers + 1))
  fi

  bidders=0
  if [ "$i" -lt "$ACTIVE_SHARDS" ]; then
    bidders=$active_bidders
  fi

  shard_id=$(printf '%02d' "$i")
  shard_aid=${LOAD_AUCTION_ID:-auc_REPLACE_ME}
  printf '\n# shard %s: observers=%s bidders=%s\n' "$shard_id" "$observers" "$bidders"
  printf 'docker compose -f infra/docker-compose.yml --profile tools run --no-deps --rm --build \\\n'
  printf '  -e TARGET="%s" \\\n' "$TARGET"
  printf '  -e LOAD_AUCTION_ID="%s" \\\n' "$shard_aid"
  printf '  -e LOAD_OBSERVERS=%s \\\n' "$observers"
  printf '  -e LOAD_BIDDERS=%s \\\n' "$bidders"
  printf '  -e LOAD_DURATION_SEC=%s \\\n' "$LOAD_DURATION_SEC"
  printf '  -e LOAD_BID_INTERVAL_MS=%s \\\n' "$LOAD_BID_INTERVAL_MS"
  printf '  -e LOAD_AUCTION_DUR_SEC=%s \\\n' "$LOAD_AUCTION_DUR_SEC"
  printf '  -e LOAD_OBSERVER_STAGGER_MS=%s \\\n' "$LOAD_OBSERVER_STAGGER_MS"
  printf '  -e LOAD_START_CENTS=%s \\\n' "$LOAD_START_CENTS"
  printf '  load\n'
done

cat <<'EOF'

# Post-run gate:
# 1. verify the shared auction id after all shards exit:
#    VERIFY_AID="$LOAD_AUCTION_ID" make verify
# 2. paste the active shard's T8 load report plus the verifier output into
#    docs/perf-report.md; observer shards supply connection/fanout evidence.
EOF
