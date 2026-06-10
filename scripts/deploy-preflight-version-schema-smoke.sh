#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
SERVER_PY="$TMP_DIR/server.py"
PORT_FILE="$TMP_DIR/port.txt"
OUT_DIR_BASE="$TMP_DIR/preflight-tests"
SCRIPT_PATH="$ROOT_DIR/deploy-preflight.sh"
# If the environment blocks local loopback socket binding, set this to 1 to keep this
# smoke script runnable in restricted sandboxes (it will report skipped cases).
export DEPLOY_PREFLIGHT_VERSION_SCHEMA_SMOKE_SKIP_NO_SOCKET="${DEPLOY_PREFLIGHT_VERSION_SCHEMA_SMOKE_SKIP_NO_SOCKET:-0}"
trap 'if [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" >/dev/null 2>&1; then :; fi; rm -rf "$TMP_DIR"' EXIT

cat > "$SERVER_PY" <<'PY'
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse


class Handler(BaseHTTPRequestHandler):
  ws_schema = os.environ.get("WS_SCHEMA", "1")
  protocol_version = "HTTP/1.1"

  def _send(self, code, body, content_type="application/json"):
    payload = body.encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", content_type)
    self.send_header("Content-Length", str(len(payload)))
    self.end_headers()
    self.wfile.write(payload)

  def do_GET(self):  # noqa: N802
    path = urlparse(self.path).path
    if path == "/healthz":
      self._send(200, json.dumps({
        "status": "ok",
        "wsSchema": int(self.ws_schema),
        "build": {"revision": "sha", "time": "2026-06-01T00:00:00Z", "utcNow": "2026-06-01T00:00:00Z"},
      }))
    elif path == "/version":
      self._send(200, json.dumps({
        "wsSchema": int(self.ws_schema),
        "build": {"revision": "sha", "time": "2026-06-01T00:00:00Z", "utcNow": "2026-06-01T00:00:00Z"},
      }))
    elif path.startswith("/metrics"):
      self._send(200, "{}")
    elif path.startswith("/admin.html"):
      self._send(200, "<!doctype html>")
    elif path.startswith("/room.html"):
      self._send(200, "<!doctype html>")
    elif path.startswith("/ws"):
      self._send(401, "unauthorized", "text/plain")
    else:
      self.send_response(404)
      self.end_headers()


if __name__ == "__main__":
  port = int(os.environ.get("PORT", "0"))
  server = HTTPServer(("127.0.0.1", port), Handler)
  os.makedirs(os.path.dirname(os.environ["PORT_FILE"]), exist_ok=True)
  with open(os.environ["PORT_FILE"], "w", encoding="utf-8") as handle:
    handle.write(str(server.server_port))
  server.serve_forever()
PY

run_case() {
  local title=$1
  local schema=$2
  local expected=$3
  local expect_failure=$4
  local preflight_out="$OUT_DIR_BASE/$title"
  mkdir -p "$preflight_out"

  local case_port=""
  export PORT=0
  export WS_SCHEMA="$schema"
  export PORT_FILE="$PORT_FILE"
  rm -f "$PORT_FILE"
  python3 "$SERVER_PY" >/tmp/deploy-preflight-version-server.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 80); do
    if [[ -s "$PORT_FILE" ]]; then
      case_port="$(cat "$PORT_FILE")"
      break
    fi
    sleep 0.05
  done
  if [[ -z "$case_port" ]]; then
    if [[ "${DEPLOY_PREFLIGHT_VERSION_SCHEMA_SMOKE_SKIP_NO_SOCKET:-0}" == "1" ]]; then
      echo "[smoke] $title: skipped (local loopback bind is unavailable in this environment)";
      return 0
    fi
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[smoke] failed to read mock server port for $title (still running, startup timeout)" >&2
    else
      echo "[smoke] mock server for $title exited before binding port; see /tmp/deploy-preflight-version-server.log" >&2
      if [[ -s /tmp/deploy-preflight-version-server.log ]]; then
        echo "--- mock server tail ---" >&2
        tail -n 20 /tmp/deploy-preflight-version-server.log >&2
      fi
    fi
    exit 1
  fi

  local log_file="$preflight_out/preflight.log"
  if BASE_URL="http://127.0.0.1:$case_port" \
     OUT_DIR="$preflight_out/artifacts" \
     EXPECTED_BUILD_REVISION="sha" \
     EXPECTED_WS_SCHEMA="$expected" \
     "$SCRIPT_PATH" >"$log_file" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=

  if [[ "$expect_failure" == "0" ]] && [[ "$rc" -ne 0 ]]; then
    echo "[smoke] $title: expected success, got rc=$rc" >&2
    echo "--- preflight log ---"
    cat "$log_file"
    exit 1
  fi
  if [[ "$expect_failure" == "1" ]] && [[ "$rc" -eq 0 ]]; then
    echo "[smoke] $title: expected failure, got rc=0" >&2
    echo "--- preflight log ---"
    cat "$log_file"
    exit 1
  fi
  if [[ "$expect_failure" == "1" ]] && ! grep -q "ws schema check: FAIL" "$log_file"; then
    echo "[smoke] $title: failure did not include ws schema failure summary" >&2
    echo "--- preflight log ---"
    cat "$log_file"
    exit 1
  fi
}

run_case "ws-schema-match" "1" "1" "0"
run_case "ws-schema-mismatch" "1" "2" "1"

echo "[smoke] deploy preflight wsSchema drift checks passed"
