#!/usr/bin/env bash
# Launch wsload detached on the worker with high fd + wide ephemeral ports.
# Usage: run-load.sh CONNS BIDDERS RAMP HOLD
# Writes /root/wsload.log and prints the PID; poll the log + gateway /metrics.
set -uo pipefail

CONNS="${1:?conns}"; BIDDERS="${2:?bidders}"; RAMP="${3:?ramp}"; HOLD="${4:?hold}"
HOSTWS="${HOSTWS:-ws://115.191.76.40:80}"
AID="${AID:?set AID env}"
TOKENS="${TOKENS:-/root/tokens.txt}"

ulimit -n 1048576 2>/dev/null || ulimit -n 65535 2>/dev/null || true
sysctl -w net.ipv4.ip_local_port_range="1024 65535" >/dev/null 2>&1 || true
sysctl -w net.core.somaxconn=4096 >/dev/null 2>&1 || true

: > /root/wsload.log
nohup /root/wsload-linux -host "$HOSTWS" -aid "$AID" -tokens "$TOKENS" \
  -conns "$CONNS" -bidders "$BIDDERS" -ramp "$RAMP" -hold "$HOLD" \
  >> /root/wsload.log 2>&1 &
PID=$!
echo "WSLOAD_PID=$PID conns=$CONNS bidders=$BIDDERS ramp=$RAMP hold=$HOLD ulimit_n=$(ulimit -n)"
