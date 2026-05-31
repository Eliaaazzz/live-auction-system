#!/usr/bin/env bash
set -euo pipefail

# Compare the same wsload scenario across two refs.
#
# This is intended for the #118/#151 review gate: prove whether the coalescing
# branch improves gateway fan-out without worse connect failures, seq gaps,
# backpressure closes, or latency. Run only in a disposable load-test
# environment; the script owns a Docker Compose project while it runs.
#
# Example:
#   BASE_REF=origin/elia/T10-issue118-fanout-lockfree \
#   HEAD_REF=origin/codex/issue118-coalescing-followup \
#   CONNS=9900 BIDDERS=100 RAMP=45s HOLD=60s \
#   tools/loadtest/wsload/compare-refs.sh

BASE_REF="${BASE_REF:-origin/elia/T10-issue118-fanout-lockfree}"
HEAD_REF="${HEAD_REF:-origin/codex/issue118-coalescing-followup}"
CONNS="${CONNS:-9900}"
BIDDERS="${BIDDERS:-100}"
RAMP="${RAMP:-45s}"
HOLD="${HOLD:-60s}"
READBUF="${READBUF:-1024}"
N_USERS="${N_USERS:-$((CONNS + BIDDERS))}"
PARALLEL="${PARALLEL:-50}"
LOAD_AUCTION_DUR_SEC="${LOAD_AUCTION_DUR_SEC:-3600}"
TARGET_HTTP="${TARGET_HTTP:-http://localhost:8080}"
TARGET_WS_LOCAL="${TARGET_WS_LOCAL:-ws://localhost:8080}"
TARGET_WS_DOCKER="${TARGET_WS_DOCKER:-ws://lumen:8080}"
WSLOAD_DRIVER="${WSLOAD_DRIVER:-docker}" # docker | local
METRICS_SAMPLE_SEC="${METRICS_SAMPLE_SEC:-5}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lumen_wsload_compare}"

root="$(git rev-parse --show-toplevel)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_root="${OUT_DIR:-/tmp/lumen-wsload-compare-$stamp}"
mkdir -p "$out_root"

cleanup() {
  for tree in "$out_root/base-tree" "$out_root/head-tree"; do
    git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

write_manifest() {
  {
    echo "base_ref=$BASE_REF"
    echo "head_ref=$HEAD_REF"
    echo "conns=$CONNS"
    echo "bidders=$BIDDERS"
    echo "ramp=$RAMP"
    echo "hold=$HOLD"
    echo "readbuf=$READBUF"
    echo "n_users=$N_USERS"
    echo "driver=$WSLOAD_DRIVER"
    echo "compose_project=$COMPOSE_PROJECT_NAME"
    echo "target_http=$TARGET_HTTP"
    echo "target_ws_local=$TARGET_WS_LOCAL"
    echo "target_ws_docker=$TARGET_WS_DOCKER"
    echo "out_root=$out_root"
  } > "$out_root/manifest.env"
}

compose() {
  worktree="$1"
  shift
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker compose -f "$worktree/infra/docker-compose.yml" "$@"
}

sample_metrics() {
  run_dir="$1"
  stop_file="$2"
  while [ ! -f "$stop_file" ]; do
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if metrics="$(curl -fsS "$TARGET_HTTP/metrics" 2>/dev/null)"; then
      printf '{"ts":"%s","metrics":%s}\n' "$ts" "$metrics"
    else
      printf '{"ts":"%s","metrics_error":"curl_failed"}\n' "$ts"
    fi
    sleep "$METRICS_SAMPLE_SEC"
  done > "$run_dir/metrics-samples.jsonl"
}

run_one() {
  name="$1"
  ref="$2"
  tree="$out_root/$name-tree"
  run_dir="$out_root/$name"
  mkdir -p "$run_dir"

  echo "== $name: $ref =="
  git -C "$root" worktree add --detach "$tree" "$ref" >/dev/null
  git -C "$tree" rev-parse HEAD > "$run_dir/commit.txt"

  compose "$tree" down >/dev/null 2>&1 || true
  compose "$tree" up -d --build --wait --wait-timeout 300

  (
    cd "$tree"
    TARGET="$TARGET_HTTP" N_USERS="$N_USERS" PARALLEL="$PARALLEL" LOAD_AUCTION_DUR_SEC="$LOAD_AUCTION_DUR_SEC" \
      bash tools/loadtest/k6-setup.sh
    cp .k6-aid tools/loadtest/.k6-aid
    cp .k6-tokens tools/loadtest/.k6-tokens
  ) | tee "$run_dir/setup.log"

  aid="$(cat "$tree/.k6-aid")"
  echo "$aid" > "$run_dir/aid.txt"

  stop_file="$run_dir/stop-metrics"
  sample_metrics "$run_dir" "$stop_file" &
  sampler_pid="$!"

  set +e
  if [ "$WSLOAD_DRIVER" = "docker" ]; then
    (
      cd "$tree/tools/loadtest/wsload"
      CGO_ENABLED=0 GOOS=linux go build -o wsload-linux .
      docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --ulimit nofile=1048576:1048576 \
        -v "$tree/tools/loadtest:/lt" alpine:3.20 /lt/wsload/wsload-linux \
        -host "$TARGET_WS_DOCKER" -aid "$aid" -tokens /lt/.k6-tokens \
        -conns "$CONNS" -bidders "$BIDDERS" -ramp "$RAMP" -hold "$HOLD" -readbuf "$READBUF"
    ) 2>&1 | tee "$run_dir/wsload.log"
  else
    (
      cd "$tree/tools/loadtest/wsload"
      go build -o "$run_dir/wsload" .
      "$run_dir/wsload" -host "$TARGET_WS_LOCAL" -aid "$aid" -tokens ../.k6-tokens \
        -conns "$CONNS" -bidders "$BIDDERS" -ramp "$RAMP" -hold "$HOLD" -readbuf "$READBUF"
    ) 2>&1 | tee "$run_dir/wsload.log"
  fi
  wsload_status="${PIPESTATUS[0]}"
  set -e

  touch "$stop_file"
  wait "$sampler_pid" || true

  curl -fsS "$TARGET_HTTP/metrics" > "$run_dir/final-metrics.json" 2>/dev/null || true
  compose "$tree" exec -T verifier /lumen verify --auction "$aid" > "$run_dir/replay-verify.log" 2>&1 || true
  compose "$tree" down >/dev/null 2>&1 || true

  {
    echo "name=$name"
    echo "ref=$ref"
    echo "commit=$(cat "$run_dir/commit.txt")"
    echo "aid=$aid"
    echo "wsload_status=$wsload_status"
    echo "wsload_log=$run_dir/wsload.log"
    echo "metrics_samples=$run_dir/metrics-samples.jsonl"
    echo "final_metrics=$run_dir/final-metrics.json"
    echo "replay_verify=$run_dir/replay-verify.log"
  } > "$run_dir/summary.env"

  grep -E 'target connections|connect OK|connect FAIL|peak concurrent|closed early|bids sent|bid-ack RTT|dial errors' \
    "$run_dir/wsload.log" > "$run_dir/wsload-key-lines.txt" || true

  return "$wsload_status"
}

write_manifest
git -C "$root" fetch origin "$BASE_REF" "$HEAD_REF" >/dev/null 2>&1 || true

status=0
run_one base "$BASE_REF" || status=1
run_one head "$HEAD_REF" || status=1

{
  echo "# wsload compare"
  echo
  echo "Artifacts: $out_root"
  echo
  echo "## base"
  cat "$out_root/base/wsload-key-lines.txt" 2>/dev/null || true
  echo
  echo "## head"
  cat "$out_root/head/wsload-key-lines.txt" 2>/dev/null || true
  echo
  echo "## files"
  echo "- manifest: $out_root/manifest.env"
  echo "- base summary: $out_root/base/summary.env"
  echo "- head summary: $out_root/head/summary.env"
} | tee "$out_root/COMPARE.md"

exit "$status"
