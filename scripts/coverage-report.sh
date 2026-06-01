#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/lumen-coverage-$(date -u +%Y%m%dT%H%M%SZ)}"
ROOT_COVER_PKGS="${ROOT_COVER_PKGS:-./apps/...}"
CHAOS_COVER_PKGS="${CHAOS_COVER_PKGS:-./...}"
RUN_CHAOS_RUNNER="${RUN_CHAOS_RUNNER:-1}"

mkdir -p "$OUT_DIR"

run_cover() {
  local name="$1"
  local dir="$2"
  local pkgs="$3"
  local profile="$OUT_DIR/${name}.out"
  local funcs="$OUT_DIR/${name}.txt"
  local html="$OUT_DIR/${name}.html"

  echo "==> ${name}: go test -covermode=atomic"
  (
    cd "$dir"
    # shellcheck disable=SC2086
    go test -covermode=atomic -coverprofile="$profile" $pkgs
    go tool cover -func="$profile" | tee "$funcs"
    go tool cover -html="$profile" -o "$html"
  )

  echo "==> ${name}: profile $profile"
  echo "==> ${name}: text    $funcs"
  echo "==> ${name}: html    $html"
}

echo "coverage output: $OUT_DIR"
echo "override ROOT_COVER_PKGS, CHAOS_COVER_PKGS, OUT_DIR, or RUN_CHAOS_RUNNER as needed"

run_cover "root" "$ROOT_DIR" "$ROOT_COVER_PKGS"

if [ "$RUN_CHAOS_RUNNER" = "1" ] && [ -f "$ROOT_DIR/tools/chaos-runner/go.mod" ]; then
  run_cover "chaos-runner" "$ROOT_DIR/tools/chaos-runner" "$CHAOS_COVER_PKGS"
else
  echo "==> chaos-runner: skipped"
fi
