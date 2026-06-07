#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/beijing-wsload-remote-10k-evidence.sh \
    --hosts /path/to/worker-hosts.tsv \
    --wsload-bin /path/to/wsload-linux \
    [--out-dir DIR]

Required env:
  RUNNER_REGION=cn-beijing
  TOKENS_FILE=/path/to/10000-tokens.txt
  METRICS_RESET_TOKEN=<operator token>

Required unless already set:
  LOAD_AUCTION_ID=auc_...
    or
  SEED_CMD='ssh root@<gateway> "LUMEN_SOURCE_DIR=/opt/live-auction-system /opt/lumen-runtime/run-lumen.sh seed-load --duration-sec 7200"'

Optional env:
  BASE_URL=http://115.191.76.40        metrics/reset endpoint reachable by this runner
  WS_HOST=ws://172.31.12.98:80         target workers dial, preferably private IP/LB
  WORKERS=2
  TOTAL_CONNS=9900
  TOTAL_BIDDERS=100
  RAMP=120s
  HOLD=180s
  METRICS_DURATION_SEC=360
  METRICS_INTERVAL_SEC=5
  SSH_KEY=/path/to/load-worker.pem
  REMOTE_DIR=/tmp/lumen-wsload-worker
  VERIFY_CMD='ssh root@<gateway> "LUMEN_SOURCE_DIR=/opt/live-auction-system /opt/lumen-runtime/run-lumen.sh verify --auction \"$LOAD_AUCTION_ID\""'

Worker hosts file:
  TSV/space-delimited lines: worker ssh_target
  Example:
    00 root@10.0.1.21
    01 root@10.0.1.22

Strict defaults:
  - requires a Beijing-near RUNNER_REGION label
  - requires /version buildSha/buildTime to be non-unknown
  - requires metrics reset before the run
  - requires remote worker shard summary, server /metrics gate, and Replay Verifier

Escape hatches for rehearsal only:
  ALLOW_NON_BEIJING=1
  ALLOW_UNKNOWN_BUILD=1
  ALLOW_DIRTY_METRICS=1
  ALLOW_MISSING_VERIFY=1
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hosts_file="${HOSTS_FILE:-}"
wsload_bin="${WSLOAD_BIN:-}"
out_dir="${OUT_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)
      hosts_file="${2:-}"
      shift 2
      ;;
    --wsload-bin)
      wsload_bin="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
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

require_region
need awk
need curl
need jq

if [[ -z "$hosts_file" ]]; then
  echo "--hosts or HOSTS_FILE is required" >&2
  exit 2
fi
if [[ -z "$wsload_bin" ]]; then
  echo "--wsload-bin or WSLOAD_BIN is required" >&2
  exit 2
fi
require_file "$hosts_file" "HOSTS_FILE"
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

tokens_file="${TOKENS_FILE:-}"
if [[ -z "$tokens_file" ]]; then
  echo "TOKENS_FILE is required" >&2
  exit 2
fi
require_file "$tokens_file" "TOKENS_FILE"

workers="${WORKERS:-}"
if [[ -z "$workers" ]]; then
  workers="$(awk 'NF >= 2 && $1 !~ /^#/ { count++ } END { print count + 0 }' "$hosts_file")"
fi
if [[ "$workers" -lt 1 ]]; then
  echo "no worker rows found in $hosts_file" >&2
  exit 2
fi

total_conns="${TOTAL_CONNS:-9900}"
total_bidders="${TOTAL_BIDDERS:-100}"
target=$((total_conns + total_bidders))
ramp="${RAMP:-120s}"
hold="${HOLD:-180s}"
metrics_duration="${METRICS_DURATION_SEC:-360}"
metrics_interval="${METRICS_INTERVAL_SEC:-5}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$out_dir" ]]; then
  out_dir="/tmp/lumen-beijing-wsload-remote-10k-${timestamp}"
fi
mkdir -p "$out_dir"
metrics_dir="$out_dir/server-metrics-window"
mkdir -p "$metrics_dir"

token_manifest "$tokens_file" "$out_dir/token-manifest.env"
token_count="$(awk -F= '$1 == "token_count" { print $2 }' "$out_dir/token-manifest.env")"
if (( token_count < target )); then
  echo "token_count=$token_count is lower than target=$target" >&2
  exit 2
fi

aid="${LOAD_AUCTION_ID:-}"
if [[ -z "$aid" ]]; then
  if [[ -z "${SEED_CMD:-}" ]]; then
    echo "LOAD_AUCTION_ID or SEED_CMD is required" >&2
    exit 2
  fi
  seed_log="$out_dir/seed-load.log"
  set +e
  sh -c "$SEED_CMD" > "$seed_log" 2>&1
  seed_rc=$?
  set -e
  printf '%s\n' "$seed_rc" > "$out_dir/seed-load.rc"
  if [[ "$seed_rc" -ne 0 ]]; then
    echo "SEED_CMD failed with exit code $seed_rc" >&2
    exit 1
  fi
  aid="$(awk -F= '/LOAD_AUCTION_ID=/{print $2}' "$seed_log" | tail -1 | tr -d '\r')"
  if [[ -z "$aid" ]]; then
    echo "SEED_CMD did not print LOAD_AUCTION_ID=..." >&2
    exit 1
  fi
fi

{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "runner_region=${RUNNER_REGION:-}"
  echo "base_url=$base_url"
  echo "ws_host=$ws_host"
  echo "load_auction_id=$aid"
  echo "workers=$workers"
  echo "total_conns=$total_conns"
  echo "total_bidders=$total_bidders"
  echo "target=$target"
  echo "ramp=$ramp"
  echo "hold=$hold"
  echo "out_dir=$out_dir"
  echo "repo_head=$(git -C "$repo_root" rev-parse --short=12 HEAD 2>/dev/null || true)"
} > "$out_dir/manifest.env"
cp "$hosts_file" "$out_dir/worker-hosts.tsv"

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

shards_dir="$out_dir/token-shards"
WORKERS="$workers" TOTAL_CONNS="$total_conns" TOTAL_BIDDERS="$total_bidders" \
  TOKENS="$tokens_file" OUT_DIR="$shards_dir" HOST_WS="$ws_host" AID="$aid" RAMP="$ramp" HOLD="$hold" \
  "$repo_root/tools/loadtest/wsload/split-tokens.sh" > "$out_dir/split-tokens.log" 2>&1

"$repo_root/scripts/v100k-metrics-snapshot.sh" \
  --url "$base_url/metrics" \
  --duration "$metrics_duration" \
  --interval "$metrics_interval" \
  --target "$target" \
  --out-dir "$metrics_dir" > "$out_dir/metrics-snapshot.log" 2>&1 &
metrics_pid=$!

remote_args=(
  --plan "$shards_dir/workers.tsv"
  --hosts "$hosts_file"
  --bin "$wsload_bin"
  --host "$ws_host"
  --aid "$aid"
  --logs-dir "$out_dir/remote-worker-logs"
  --ramp "$ramp"
  --hold "$hold"
)
if [[ -n "${SSH_KEY:-}" ]]; then
  remote_args+=(--ssh-key "$SSH_KEY")
fi
if [[ -n "${REMOTE_DIR:-}" ]]; then
  remote_args+=(--remote-dir "$REMOTE_DIR")
fi

set +e
"$repo_root/tools/loadtest/wsload/run-remote-workers.sh" "${remote_args[@]}" \
  > "$out_dir/remote-workers.log" 2>&1
remote_rc=$?
set -e
printf '%s\n' "$remote_rc" > "$out_dir/remote-workers.rc"

set +e
wait "$metrics_pid"
metrics_rc=$?
set -e
printf '%s\n' "$metrics_rc" > "$out_dir/metrics-snapshot.rc"

curl -fsS "$base_url/metrics" > "$out_dir/metrics-after-run.json"
capture_host "after" "$out_dir"

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
    --shards "$out_dir/remote-worker-logs/shards.tsv" \
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
if [[ "$remote_rc" -ne 0 || "$metrics_rc" -ne 0 || "$server_gate_rc" -ne 0 || "$wsload_gate_rc" -ne 0 || "$verify_rc" -ne 0 ]]; then
  result="FAIL"
fi
if [[ -f "$out_dir/server-gate/gate.tsv" ]] && grep -q $'\tFAIL\t' "$out_dir/server-gate/gate.tsv"; then
  result="FAIL"
fi
if [[ -f "$out_dir/wsload-gate/gate.tsv" ]] && grep -q $'\tFAIL\t' "$out_dir/wsload-gate/gate.tsv"; then
  result="FAIL"
fi

{
  echo "# Beijing remote wsload 10k evidence"
  echo
  echo "- result: $result"
  echo "- generated_at_utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "- runner_region: ${RUNNER_REGION:-}"
  echo "- base_url: $base_url"
  echo "- ws_host: $ws_host"
  echo "- load_auction_id: $aid"
  echo "- workers: $workers"
  echo "- target_connections: $target"
  echo "- selected_metrics: server-metrics-window/metrics.json"
  echo "- remote_worker_logs: remote-worker-logs/"
  echo "- worker_host_snapshots: remote-worker-logs/host-*-before.txt and remote-worker-logs/host-*-after.txt"
  echo "- shard_summary: remote-worker-logs/shards.tsv"
  echo "- server_gate: server-gate/gate.tsv"
  echo "- wsload_gate: wsload-gate/gate.tsv"
  echo "- replay_verifier: replay-verifier.log"
  echo
  echo "Token values are intentionally excluded from this evidence summary."
} > "$out_dir/summary.md"

echo "result=$result"
echo "evidence_dir=$out_dir"
echo "summary=$out_dir/summary.md"

if [[ "$result" != "PASS" ]]; then
  exit 1
fi
