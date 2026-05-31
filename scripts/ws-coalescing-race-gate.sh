#!/usr/bin/env bash
set -euo pipefail

# Focused race gate for the #118/#151 WebSocket fanout/coalescing path.
# Run this from any branch that touches apps/lumen/internal/server/ws*.go.
# It writes an auditable log under /tmp and exits non-zero on a race/test failure.

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$ROOT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-/tmp/lumen-ws-coalescing-race-gate-$STAMP}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/go-test-race.log"
SUMMARY="$OUT_DIR/summary.txt"

PATTERN='Test(Buffer|WritePump|WSServerFlushesPongPromptly|CoalesceDrain|CriticalLane|JoinBarrier|Broadcast|Fanout|T5|T2|Hidden)'
PACKAGE='./apps/lumen/internal/server'

{
  echo "ws coalescing race gate"
  echo "repo=$(git config --get remote.origin.url 2>/dev/null || true)"
  echo "commit=$(git rev-parse HEAD)"
  echo "branch=$(git branch --show-current || true)"
  echo "go=$(go version)"
  echo "package=$PACKAGE"
  echo "pattern=$PATTERN"
  echo "out_dir=$OUT_DIR"
} | tee "$SUMMARY"

set +e
go test -race "$PACKAGE" -run "$PATTERN" -count=1 -v 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e

{
  echo "status=$STATUS"
  echo "log=$LOG"
} | tee -a "$SUMMARY"

exit "$STATUS"
