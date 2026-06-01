#!/usr/bin/env bash
set -euo pipefail

# Compare Go benchmark output for the current checkout against a base ref.
#
# Default scope is intentionally narrow: the #92 G5 hot-path benchmarks live in
# the metrics and store packages. Override BENCH_PKGS or BENCH_PATTERN when
# running a wider perf review.
#
# Examples:
#   scripts/bench-diff.sh
#   BASE_REF=origin/main BENCH_TIME=3s scripts/bench-diff.sh
#   BENCH_PATTERN='BenchmarkPlaceBidLuaHotPath' scripts/bench-diff.sh

BASE_REF="${BASE_REF:-origin/main}"
BENCH_PATTERN="${BENCH_PATTERN:-Benchmark}"
BENCH_COUNT="${BENCH_COUNT:-5}"
BENCH_TIME="${BENCH_TIME:-1s}"
BENCH_PKGS="${BENCH_PKGS:-./apps/lumen/internal/metrics ./apps/lumen/internal/store}"

root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/lumen-bench-diff.XXXXXX")"
base_tree="$tmp/base"
base_out="$tmp/base.txt"
head_out="$tmp/head.txt"
keep_outputs=0

cleanup() {
  git -C "$root" worktree remove --force "$base_tree" >/dev/null 2>&1 || true
  if [ "$keep_outputs" != "1" ]; then
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

printf 'bench-diff: base=%s pattern=%s count=%s benchtime=%s\n' "$BASE_REF" "$BENCH_PATTERN" "$BENCH_COUNT" "$BENCH_TIME" >&2
printf 'bench-diff: packages=%s\n' "$BENCH_PKGS" >&2

git -C "$root" worktree add --detach "$base_tree" "$BASE_REF" >/dev/null

run_bench() {
  dir="$1"
  out="$2"
  (
    cd "$dir"
    go test -run '^$' -bench "$BENCH_PATTERN" -benchmem -count "$BENCH_COUNT" -benchtime "$BENCH_TIME" $BENCH_PKGS
  ) | tee "$out"
}

printf '\n== base: %s ==\n' "$BASE_REF" >&2
run_bench "$base_tree" "$base_out"

printf '\n== head: %s ==\n' "$(git -C "$root" rev-parse --short HEAD)" >&2
run_bench "$root" "$head_out"

printf '\n== benchstat ==\n'
if command -v benchstat >/dev/null 2>&1; then
  benchstat "$base_out" "$head_out"
else
  keep_outputs=1
  printf 'benchstat not found; raw benchmark outputs preserved in:\n'
  printf '  base: %s\n' "$base_out"
  printf '  head: %s\n' "$head_out"
  printf 'Install with: go install golang.org/x/perf/cmd/benchstat@latest\n'
fi
