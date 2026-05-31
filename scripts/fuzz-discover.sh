#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUZZTIME="${FUZZTIME:-10s}"
ROOT_FUZZ_PKGS="${ROOT_FUZZ_PKGS:-./apps/...}"
CHAOS_FUZZ_PKGS="${CHAOS_FUZZ_PKGS:-./...}"
RUN_CHAOS_RUNNER="${RUN_CHAOS_RUNNER:-1}"
EXTRA_GO_TEST_FLAGS="${EXTRA_GO_TEST_FLAGS:-}"

run_suite() {
  local name="$1"
  local dir="$2"
  local pkgs="$3"

  echo "==> ${name}: scanning ${pkgs}"
  (
    cd "$dir"

    local pkg_list
    pkg_list="$(mktemp)"
    # shellcheck disable=SC2086
    go list $pkgs > "$pkg_list"

    local found=0
    local pkg
    while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue

      local targets
      targets="$(go test -run '^$' -list '^Fuzz' "$pkg")"

      local target
      while IFS= read -r target; do
        case "$target" in
          Fuzz*)
            found=$((found + 1))
            echo "==> ${name}: fuzz ${pkg} ${target} for ${FUZZTIME}"
            # shellcheck disable=SC2086
            go test -run '^$' -fuzz="^${target}$" -fuzztime="$FUZZTIME" $EXTRA_GO_TEST_FLAGS "$pkg"
            ;;
        esac
      done <<< "$targets"
    done < "$pkg_list"

    rm -f "$pkg_list"

    if [ "$found" -eq 0 ]; then
      echo "==> ${name}: no fuzz targets found"
    else
      echo "==> ${name}: ran ${found} fuzz target(s)"
    fi
  )
}

echo "fuzztime: $FUZZTIME"
echo "override ROOT_FUZZ_PKGS, CHAOS_FUZZ_PKGS, RUN_CHAOS_RUNNER, or EXTRA_GO_TEST_FLAGS as needed"

run_suite "root" "$ROOT_DIR" "$ROOT_FUZZ_PKGS"

if [ "$RUN_CHAOS_RUNNER" = "1" ] && [ -f "$ROOT_DIR/tools/chaos-runner/go.mod" ]; then
  run_suite "chaos-runner" "$ROOT_DIR/tools/chaos-runner" "$CHAOS_FUZZ_PKGS"
else
  echo "==> chaos-runner: skipped"
fi
