#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUT_DIR="${OUT_DIR:-/tmp/lumen-demo-evidence-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DEMO_ASSERTIONS="${RUN_DEMO_ASSERTIONS:-0}"
ALLOW_FAILURE="${ALLOW_FAILURE:-0}"

mkdir -p "$OUT_DIR"

STATUS_FILE="$OUT_DIR/status.tsv"
MANIFEST_FILE="$OUT_DIR/manifest.txt"

printf "step\texit_code\tartifact\n" > "$STATUS_FILE"

{
  echo "lumen demo evidence pack"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_url=$BASE_URL"
  echo "out_dir=$OUT_DIR"
  if command -v git >/dev/null 2>&1; then
    echo "git_head=$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
    echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
  fi
  echo
  echo "Required checks capture the non-destructive rehearsal evidence."
  echo "Set RUN_DEMO_ASSERTIONS=1 to also run demo/load/chaos assertion targets."
} > "$MANIFEST_FILE"

failures=0

record_cmd() {
  local name="$1"
  shift
  local log="$OUT_DIR/${name}.log"
  local rc

  echo "==> $name"
  set +e
  "$@" >"$log" 2>&1
  rc=$?
  set -e

  printf "%s\t%d\t%s\n" "$name" "$rc" "$log" >> "$STATUS_FILE"
  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> $name failed with exit code $rc; see $log"
  fi
}

record_cmd "healthz" curl -fsS "$BASE_URL/healthz"
record_cmd "metrics" curl -fsS "$BASE_URL/metrics"
record_cmd "verify" make verify
record_cmd "verify-evidence" make verify-evidence

if [ "$RUN_DEMO_ASSERTIONS" = "1" ]; then
  record_cmd "demo-auction" make demo-auction
  record_cmd "load-smoke" make load-smoke
  record_cmd "chaos-smoke" make chaos-smoke
fi

{
  echo
  echo "status_file=$STATUS_FILE"
  echo "failed_steps=$failures"
} >> "$MANIFEST_FILE"

echo "evidence pack: $OUT_DIR"
echo "manifest:      $MANIFEST_FILE"
echo "status:        $STATUS_FILE"

if [ "$failures" -ne 0 ] && [ "$ALLOW_FAILURE" != "1" ]; then
  exit 1
fi
