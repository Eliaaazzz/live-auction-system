#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
DURATION_SEC="${DURATION_SEC:-600}"
ITERATION_SLEEP_SEC="${ITERATION_SLEEP_SEC:-5}"
SOAK_CMD="${SOAK_CMD:-make load-smoke}"
OUT_DIR="${OUT_DIR:-/tmp/lumen-soak-$(date -u +%Y%m%dT%H%M%SZ)}"
ALLOW_FAILURE="${ALLOW_FAILURE:-0}"

mkdir -p "$OUT_DIR"

STATUS_FILE="$OUT_DIR/status.tsv"
MANIFEST_FILE="$OUT_DIR/manifest.txt"
METRICS_DIR="$OUT_DIR/metrics"
mkdir -p "$METRICS_DIR"

printf "iteration\tstarted_at\texit_code\tcommand_log\tmetrics_artifact\n" > "$STATUS_FILE"

{
  echo "lumen soak runner"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_url=$BASE_URL"
  echo "duration_sec=$DURATION_SEC"
  echo "iteration_sleep_sec=$ITERATION_SLEEP_SEC"
  echo "soak_cmd=$SOAK_CMD"
  echo "out_dir=$OUT_DIR"
  if command -v git >/dev/null 2>&1; then
    echo "git_head=$(cd "$ROOT_DIR" && git rev-parse --short=12 HEAD 2>/dev/null || true)"
    echo "git_branch=$(cd "$ROOT_DIR" && git branch --show-current 2>/dev/null || true)"
  fi
  echo
  echo "Purpose: repeat the configured smoke/load command and preserve logs plus metrics snapshots for soak evidence."
} > "$MANIFEST_FILE"

end_at=$(( $(date +%s) + DURATION_SEC ))
iteration=0
failures=0

while [ "$(date +%s)" -lt "$end_at" ]; do
  iteration=$((iteration + 1))
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cmd_log="$OUT_DIR/iteration-${iteration}.log"
  metrics_artifact="$METRICS_DIR/metrics-${iteration}.json"

  echo "==> iteration $iteration: $SOAK_CMD"

  set +e
  (
    cd "$ROOT_DIR"
    bash -lc "$SOAK_CMD"
  ) >"$cmd_log" 2>&1
  rc=$?
  curl -fsS --max-time 10 "$BASE_URL/metrics" >"$metrics_artifact" 2>"$METRICS_DIR/metrics-${iteration}.err"
  metrics_rc=$?
  set -e

  if [ "$metrics_rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> iteration $iteration metrics scrape failed with exit code $metrics_rc"
  fi

  printf "%s\t%s\t%s\t%s\t%s\n" "$iteration" "$started_at" "$rc" "$cmd_log" "$metrics_artifact" >> "$STATUS_FILE"

  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> iteration $iteration command failed with exit code $rc"
  fi

  if [ "$(date +%s)" -lt "$end_at" ]; then
    sleep "$ITERATION_SLEEP_SEC"
  fi
done

{
  echo
  echo "iterations=$iteration"
  echo "failed_checks=$failures"
  echo "status_file=$STATUS_FILE"
  echo "metrics_dir=$METRICS_DIR"
} >> "$MANIFEST_FILE"

echo "soak pack:  $OUT_DIR"
echo "manifest:   $MANIFEST_FILE"
echo "status:     $STATUS_FILE"
echo "metrics:    $METRICS_DIR"

if [ "$failures" -ne 0 ] && [ "$ALLOW_FAILURE" != "1" ]; then
  exit 1
fi
