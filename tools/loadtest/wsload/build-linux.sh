#!/usr/bin/env bash
# Cross-compile wsload to a static linux/amd64 binary for upload to a Beijing
# in-VPC load worker (issue #231 Tier-1 path). CGO is disabled so the binary
# runs on a bare ECS with no Go toolchain or libc surprises.
#
# Usage:
#   tools/loadtest/wsload/build-linux.sh [output-name]   # default: wsload-linux
#
# Then copy it to the worker and run it against the gateway PRIVATE IP / private
# LB (never the public EIP — see docs/runbooks/beijing-tier1-10k-demo.md):
#   scp wsload-linux root@<worker>:/opt/lumen-load/
set -euo pipefail
cd "$(dirname "$0")"

out="${1:-wsload-linux}"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$out" .

echo "built: $out"
ls -la "$out"
command -v file >/dev/null 2>&1 && file "$out" || true
