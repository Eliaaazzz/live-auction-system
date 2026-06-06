#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/beijing-wsload-10k-evidence.sh --wsload-bin /path/to/wsload [--out-dir DIR]

Required env:
  RUNNER_REGION=cn-beijing
  LOAD_AUCTION_ID=auc_...
  TOKENS_FILE=/path/to/tokens.txt
  METRICS_RESET_TOKEN=<operator token>

Optional env:
  BASE_URL=http://115.191.76.40
  WS_HOST=ws://115.191.76.40
  OBSERVERS=9900
  BIDDERS=100
  RAMP=120s
  HOLD=180s
  METRICS_DURATION_SEC=360
  METRICS_INTERVAL_SEC=5
  VERIFY_CMD='LUMEN_SOURCE_DIR=/opt/live-auction-system /opt/lumen-runtime/run-lumen.sh verify --auction "$LOAD_AUCTION_ID"'

Strict defaults:
  - requires a Beijing-near RUNNER_REGION label
  - requires /version buildSha/buildTime to be non-unknown
  - requires metrics reset before the run
  - gates server /metrics, wsload connect counts, and Replay Verifier output

Escape hatches for rehearsal only:
  ALLOW_NON_BEIJING=1
  ALLOW_UNKNOWN_BUILD=1
  ALLOW_DIRTY_METRICS=1
  ALLOW_MISSING_VERIFY=1
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${OUT_DIR:-}"
wsload_bin="${WSLOAD_BIN:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    --wsload-bin)
      wsload_bin="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 2
  }
}

require_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    echo "$label not found: $path" >&2
    exit 2
  fi
}

require_region() {
  local region="${RUNNER_REGION:-}"
  local normalized="${region,,}"
  case "$normalized" in
    *beijing*|*cn-beijing*|*north-china*|*northchina*|*huabei*)
      return
      ;;
  esac
  if [[ "${ALLOW_NON_BEIJING:-0}" != "1" ]]; then
    echo "RUNNER_REGION must identify a Beijing-near worker; got '${region:-<unset>}'" >&2
    exit 2
  fi
}

capture_host() {
  local stage="$1"
  local dir="$2/host-${stage}"
  mkdir -p "$dir"
  {
    echo "stage=$stage"
    date -u '+captured_at_utc=%Y-%m-%dT%H:%M:%SZ'
    echo "runner_region=${RUNNER_REGION:-}"
    echo "hostname=$(hostname 2>/dev/null || true)"
    echo "ulimit_n=$(ulimit -n 2>/dev/null || true)"
  } > "$dir/manifest.txt"
  uname -a > "$dir/uname.txt" 2>&1 || true
  nproc > "$dir/nproc.txt" 2>&1 || true
  free -m > "$dir/free-m.txt" 2>&1 || true
  df -h > "$dir/df-h.txt" 2>&1 || true
  ss -s > "$dir/ss-s.txt" 2>&1 || true
  ip addr > "$dir/ip-addr.txt" 2>&1 || true
  sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog net.ipv4.ip_local_port_range \
    > "$dir/sysctl-network.txt" 2>&1 || true
  ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu | head -40 > "$dir/top-processes.txt" 2>&1 || true
}

token_manifest() {
  local file="$1"
  local out="$2"
  {
    echo "tokens_file=$file"
    echo "token_count=$(grep -Ec '^user_[^.]+\.[a-f0-9]{64}$' "$file" || true)"
    if command -v sha256sum >/dev/null 2>&1; then
      echo "tokens_sha256=$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      echo "tokens_sha256=$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
  } > "$out"
}

python_bin="${PYTHON_BIN:-}"
if [[ -z "$python_bin" ]]; then
  if command -v python >/dev/null 2>&1; then
    python_bin="python"
  elif command -v python3 >/dev/null 2>&1; then
    python_bin="python3"
  else
    echo "missing required tool: python or python3" >&2
    exit 2
  fi
fi

require_region
need curl
need jq
need awk

if [[ -z "$wsload_bin" ]]; then
  echo "--wsload-bin or WSLOAD_BIN is required" >&2
  exit 2
fi
require_file "$wsload_bin" "WSLOAD_BIN"

base_url="${BASE_URL:-http://115.191.76.40}"
base_url="${base_url%/}"
if [[ -n "${WS_HOST:-}" ]]; then
  ws_host="$WS_HOST"
elif [[ "$base_url" == https://* ]]; then
  ws_host="wss://${base_url#https://}"
else
  ws_host="ws://${base_url#http://}"
fi

aid="${LOAD_AUCTION_ID:-}"
tokens_file="${TOKENS_FILE:-}"
observers="${OBSERVERS:-9900}"
bidders="${BIDDERS:-100}"
ramp="${RAMP:-120s}"
hold="${HOLD:-180s}"
metrics_duration="${METRICS_DURATION_SEC:-360}"
metrics_interval="${METRICS_INTERVAL_SEC:-5}"
target=$((observers + bidders))

if [[ -z "$aid" ]]; then
  echo "LOAD_AUCTION_ID is required" >&2
  exit 2
fi
if [[ -z "$tokens_file" ]]; then
  echo "TOKENS_FILE is required" >&2
  exit 2
fi
require_file "$tokens_file" "TOKENS_FILE"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$out_dir" ]]; then
  out_dir="/tmp/lumen-beijing-wsload-10k-${timestamp}"
fi
mkdir -p "$out_dir"
metrics_dir="$out_dir/server-metrics-window"
mkdir -p "$metrics_dir"

token_manifest "$tokens_file" "$out_dir/token-manifest.env"
{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "runner_region=${RUNNER_REGION:-}"
  echo "base_url=$base_url"
  echo "ws_host=$ws_host"
  echo "load_auction_id=$aid"
  echo "observers=$observers"
  echo "bidders=$bidders"
  echo "target=$target"
  echo "ramp=$ramp"
  echo "hold=$hold"
  echo "out_dir=$out_dir"
  echo "repo_head=$(git -C "$repo_root" rev-parse --short=12 HEAD 2>/dev/null || true)"
} > "$out_dir/manifest.env"

curl -fsS "$base_url/healthz" > "$out_dir/healthz.json"
curl -fsS "$base_url/version" > "$out_dir/version.json"
build_sha="$(jq -r '.buildSha // "unknown"' "$out_dir/version.json")"
build_time="$(jq -r '.buildTime // "unknown"' "$out_dir/version.json")"
schema_version="$(jq -r '.schemaVersion // 0' "$out_dir/version.json")"
if [[ "$schema_version" != "2" ]]; then
  echo "/version schemaVersion=$schema_version, want 2" >&2
  exit 1
fi
if [[ "${ALLOW_UNKNOWN_BUILD:-0}" != "1" && ("$build_sha" == "unknown" || "$build_time" == "unknown") ]]; then
  echo "/version buildSha/buildTime must be non-unknown for final evidence" >&2
  exit 1
fi

curl -fsS "$base_url/metrics" > "$out_dir/metrics-before-reset.json"
if [[ -n "${METRICS_RESET_TOKEN:-}" ]]; then
  curl -fsS -X POST \
    -H "X-Lumen-Metrics-Reset-Token: ${METRICS_RESET_TOKEN}" \
    "$base_url/admin/metrics/reset" > "$out_dir/metrics-reset.json"
  curl -fsS "$base_url/metrics" > "$out_dir/metrics-clean.json"
  jq -e '.activeConns == 0 and .ackLatencyMs.count == 0 and .broadcastLatencyMs.count == 0 and .roomStatePatchLatencyMs.count == 0' \
    "$out_dir/metrics-clean.json" >/dev/null
elif [[ "${ALLOW_DIRTY_METRICS:-0}" != "1" ]]; then
  echo "METRICS_RESET_TOKEN is required for clean run-window metrics" >&2
  exit 2
fi

capture_host "before" "$out_dir"
"$repo_root/scripts/v100k-metrics-snapshot.sh" \
  --url "$base_url/metrics" \
  --duration "$metrics_duration" \
  --interval "$metrics_interval" \
  --target "$target" \
  --out-dir "$metrics_dir" > "$out_dir/metrics-snapshot.log" 2>&1 &
metrics_pid=$!

set +e
"$wsload_bin" \
  -host "$ws_host" \
  -aid "$aid" \
  -tokens "$tokens_file" \
  -conns "$observers" \
  -bidders "$bidders" \
  -ramp "$ramp" \
  -hold "$hold" > "$out_dir/wsload.log" 2>&1
wsload_rc=$?
set -e
printf '%s\n' "$wsload_rc" > "$out_dir/wsload.rc"

set +e
wait "$metrics_pid"
metrics_rc=$?
set -e
printf '%s\n' "$metrics_rc" > "$out_dir/metrics-snapshot.rc"

curl -fsS "$base_url/metrics" > "$out_dir/metrics-after-run.json"
capture_host "after" "$out_dir"

"$python_bin" - "$out_dir/wsload.log" "$out_dir/wsload-summary.json" "$out_dir/shards.tsv" <<'PY'
import json
import re
import sys
from pathlib import Path

log_path, json_path, shards_path = map(Path, sys.argv[1:])
text = log_path.read_text(errors="replace")

def grab(pattern, default=0, cast=int):
    m = re.search(pattern, text, re.I | re.M)
    if not m:
        return default
    value = m.group(1).replace(",", "")
    return cast(value)

summary = {
    "target_connections": grab(r"target connections\s*:\s*([0-9,]+)"),
    "connect_ok": grab(r"connect OK\s*:\s*([0-9,]+)"),
    "connect_fail": grab(r"connect FAIL\s*:\s*([0-9,]+)"),
    "peak_concurrent": grab(r"peak concurrent\s*:\s*([0-9,]+)"),
    "closed_early": grab(r"closed early.*?:\s*([0-9,]+)"),
    "frames_received": grab(r"frames received\s*:\s*([0-9,]+)"),
}
bids = re.search(r"bids sent / acc / rej\s*:\s*([0-9,]+)\s*/\s*([0-9,]+)\s*/\s*([0-9,]+)", text, re.I)
if bids:
    summary["bids_sent"] = int(bids.group(1).replace(",", ""))
    summary["bids_accepted"] = int(bids.group(2).replace(",", ""))
    summary["bids_rejected"] = int(bids.group(3).replace(",", ""))
ack = re.search(r"bid-ack RTT.*?p50=([0-9.]+)ms p95=([0-9.]+)ms p99=([0-9.]+)ms max=([0-9.]+)ms\s+\(n=([0-9,]+)", text, re.I)
if ack:
    summary["client_bid_ack_rtt_ms"] = {
        "p50": float(ack.group(1)),
        "p95": float(ack.group(2)),
        "p99": float(ack.group(3)),
        "max": float(ack.group(4)),
        "count": int(ack.group(5).replace(",", "")),
    }
summary["connect_fail_rate"] = (
    summary["connect_fail"] / max(1, summary["connect_ok"] + summary["connect_fail"])
)
json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
shards_path.write_text(
    "worker\ttarget_conns\tconnect_ok\tconnect_fail\tclosed_early\n"
    f"00\t{summary['target_connections']}\t{summary['connect_ok']}\t{summary['connect_fail']}\t{summary['closed_early']}\n",
    encoding="utf-8",
)
PY

server_metrics="$metrics_dir/metrics.json"
server_gate_rc=1
wsload_gate_rc=1
if [[ -f "$server_metrics" ]]; then
  set +e
  REQUIRE_HAMMER=0 REQUIRE_CATCHUP=0 TARGET_CONNS="$target" \
    "$repo_root/scripts/remote-perf-gate.sh" \
    --server-metrics "$server_metrics" \
    --target "$target" \
    --out-dir "$out_dir/server-gate" > "$out_dir/server-gate.log" 2>&1
  server_gate_rc=$?
  set -e
  printf '%s\n' "$server_gate_rc" > "$out_dir/server-gate.rc"

  set +e
  TARGET_CONNS="$target" \
    "$repo_root/scripts/v100k-evidence-gate.sh" \
    --metrics "$server_metrics" \
    --shards "$out_dir/shards.tsv" \
    --target "$target" \
    --out-dir "$out_dir/wsload-gate" > "$out_dir/wsload-gate.log" 2>&1
  wsload_gate_rc=$?
  set -e
  printf '%s\n' "$wsload_gate_rc" > "$out_dir/wsload-gate.rc"
else
  echo "server metrics selection missing: $server_metrics" > "$out_dir/server-gate.log"
  echo "server metrics selection missing: $server_metrics" > "$out_dir/wsload-gate.log"
  printf '%s\n' "$server_gate_rc" > "$out_dir/server-gate.rc"
  printf '%s\n' "$wsload_gate_rc" > "$out_dir/wsload-gate.rc"
fi

verify_rc=0
if [[ -n "${VERIFY_CMD:-}" ]]; then
  set +e
  LOAD_AUCTION_ID="$aid" sh -c "$VERIFY_CMD" > "$out_dir/replay-verifier.log" 2>&1
  verify_rc=$?
  set -e
  printf '%s\n' "$verify_rc" > "$out_dir/replay-verifier.rc"
elif [[ "${ALLOW_MISSING_VERIFY:-0}" != "1" ]]; then
  echo "VERIFY_CMD is required for final evidence" >&2
  exit 2
fi

result="PASS"
if [[ "$wsload_rc" -ne 0 || "$metrics_rc" -ne 0 || "$server_gate_rc" -ne 0 || "$wsload_gate_rc" -ne 0 || "$verify_rc" -ne 0 ]]; then
  result="FAIL"
fi
if [[ -f "$out_dir/server-gate/gate.tsv" ]] && grep -q $'\tFAIL\t' "$out_dir/server-gate/gate.tsv"; then
  result="FAIL"
fi
if [[ -f "$out_dir/wsload-gate/gate.tsv" ]] && grep -q $'\tFAIL\t' "$out_dir/wsload-gate/gate.tsv"; then
  result="FAIL"
fi

{
  echo "# Beijing wsload 10k evidence"
  echo
  echo "- result: $result"
  echo "- generated_at_utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "- runner_region: ${RUNNER_REGION:-}"
  echo "- base_url: $base_url"
  echo "- ws_host: $ws_host"
  echo "- load_auction_id: $aid"
  echo "- target_connections: $target"
  echo "- wsload_summary: wsload-summary.json"
  echo "- selected_metrics: server-metrics-window/metrics.json"
  echo "- server_gate: server-gate/gate.tsv"
  echo "- wsload_gate: wsload-gate/gate.tsv"
  echo "- replay_verifier: replay-verifier.log"
  echo
  echo "Token values are intentionally not copied into this evidence directory."
} > "$out_dir/summary.md"

echo "result=$result"
echo "evidence_dir=$out_dir"
echo "summary=$out_dir/summary.md"

if [[ "$result" != "PASS" ]]; then
  exit 1
fi
