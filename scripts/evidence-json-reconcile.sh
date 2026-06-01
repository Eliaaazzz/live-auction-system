#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/lumen-evidence-json-reconcile-$(date -u +%Y%m%dT%H%M%SZ)}"
RUNS="${RUNS:-3}"
VERIFY_AID="${VERIFY_AID:-}"
BASELINE_SHA_FILE="${BASELINE_SHA_FILE:-}"
ALLOW_FAILURE="${ALLOW_FAILURE:-0}"

mkdir -p "$OUT_DIR"

STATUS_FILE="$OUT_DIR/status.tsv"
MANIFEST_FILE="$OUT_DIR/manifest.txt"
SHA_FILE="$OUT_DIR/run-1.sha256"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

{
  echo "lumen evidence json reconcile"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "out_dir=$OUT_DIR"
  echo "runs=$RUNS"
  echo "verify_aid=$VERIFY_AID"
  echo "baseline_sha_file=$BASELINE_SHA_FILE"
  if command -v git >/dev/null 2>&1; then
    echo "git_head=$(cd "$ROOT_DIR" && git rev-parse --short=12 HEAD 2>/dev/null || true)"
    echo "git_branch=$(cd "$ROOT_DIR" && git branch --show-current 2>/dev/null || true)"
  fi
  echo
  echo "Purpose: capture repeat evidence-chain verification output before/after MySQL JSON-normalization-sensitive changes."
  echo "Usage: run once before upgrade, preserve run-1.sha256, then rerun after upgrade with BASELINE_SHA_FILE=<saved file>."
} > "$MANIFEST_FILE"

printf "run\texit_code\tsha256\tartifact\n" > "$STATUS_FILE"

failures=0
first_sha=""

for i in $(seq 1 "$RUNS"); do
  log="$OUT_DIR/run-${i}.log"
  echo "==> verify-evidence run $i/$RUNS"

  set +e
  (
    cd "$ROOT_DIR"
    VERIFY_AID="$VERIFY_AID" make verify-evidence
  ) >"$log" 2>&1
  rc=$?
  set -e

  digest="$(sha256_file "$log")"
  printf "%s\t%d\t%s\t%s\n" "$i" "$rc" "$digest" "$log" >> "$STATUS_FILE"

  if [ "$i" = "1" ]; then
    first_sha="$digest"
    printf "%s\n" "$digest" > "$SHA_FILE"
  elif [ "$digest" != "$first_sha" ]; then
    failures=$((failures + 1))
    echo "==> run $i output digest differs from run 1"
  fi

  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> run $i failed with exit code $rc; see $log"
  fi
done

if [ -n "$BASELINE_SHA_FILE" ]; then
  baseline="$(tr -d '[:space:]' < "$BASELINE_SHA_FILE")"
  if [ "$first_sha" != "$baseline" ]; then
    failures=$((failures + 1))
    echo "==> run 1 digest differs from baseline $BASELINE_SHA_FILE"
  fi
fi

{
  echo
  echo "status_file=$STATUS_FILE"
  echo "run_1_sha_file=$SHA_FILE"
  echo "failed_checks=$failures"
} >> "$MANIFEST_FILE"

echo "reconcile pack: $OUT_DIR"
echo "manifest:       $MANIFEST_FILE"
echo "status:         $STATUS_FILE"
echo "run 1 sha:      $SHA_FILE"

if [ "$failures" -ne 0 ] && [ "$ALLOW_FAILURE" != "1" ]; then
  exit 1
fi
