#!/usr/bin/env bash
# Deploy the merged lumen binary onto the gateway with backup + auto-rollback.
# Run IN the gateway's console web terminal after fetching /tmp/lumen-new.
set -uo pipefail
BIN=/opt/lumen-runtime/bin/lumen
NEW=/tmp/lumen-new
[ -x "$NEW" ] || { echo "FATAL: $NEW missing or not executable (curl it first, then chmod +x)"; exit 1; }

echo "=== current state ==="
PID=$(pgrep -x lumen | head -1); echo "lumen pid: ${PID:-none}"
UNIT=$(systemctl list-units --type=service --all --no-legend 2>/dev/null | grep -io '[a-z0-9@._-]*lumen[a-z0-9@._-]*\.service' | head -1)
echo "systemd unit: ${UNIT:-none}"
curl -s --max-time 5 http://127.0.0.1/version 2>/dev/null; echo

echo "=== backup current binary ==="
BAK="${BIN}.bak.$(date +%s)"
cp -a "$BIN" "$BAK" && echo "backup -> $BAK"

restart() {
  if [ -n "$UNIT" ]; then systemctl restart "$UNIT";
  else pkill -x lumen 2>/dev/null || true; sleep 3; fi   # supervisor (it auto-respawned after the OOM crash) brings it back with the new binary
}
healthy() { sleep 3; for i in 1 2 3 4 5; do curl -fs --max-time 5 http://127.0.0.1/healthz >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }

echo "=== swap + restart ==="
install -m 0755 "$NEW" "$BIN"
restart

if healthy; then
  echo "OK — /healthz is up on the new binary"
  echo -n "version: "; curl -s --max-time 5 http://127.0.0.1/version; echo
  echo -n "/metrics now exposes: "; curl -s --max-time 5 http://127.0.0.1/metrics | grep -o '"min"\|"p999"' | sort -u | tr '\n' ' '; echo
  echo "DONE. (old binary kept at $BAK)"
else
  echo "!! /healthz did NOT come up — ROLLING BACK to $BAK"
  install -m 0755 "$BAK" "$BIN"
  restart
  if healthy; then echo "rollback OK — gateway restored on old binary"; else echo "!!! rollback /healthz still down — check process manually"; fi
fi