#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/beijing-locust-10k-evidence.sh master [--out-dir DIR]
  scripts/beijing-locust-10k-evidence.sh worker --master-host HOST [--out-dir DIR]

Required env:
  RUNNER_REGION=cn-beijing
  LOAD_AUCTION_ID=auc_...
  TOKENS_FILE=/path/to/tokens.txt

Master env:
  BASE_URL=http://115.191.76.40
  WS_HOST=ws://115.191.76.40
  EXPECT_WORKERS=8
  USERS=10000
  SPAWN_RATE=500
  RUN_TIME=180s
  METRICS_RESET_TOKEN=<operator token>
  VERIFY_CMD='ssh <ecs> "cd live-auction-system && VERIFY_AID=$LOAD_AUCTION_ID make verify"'

Worker env:
  MASTER_HOST=<master private ip>
  PROCESSES=4

Strict defaults:
  - requires a Beijing-near RUNNER_REGION label
  - requires /version buildSha/buildTime to be non-unknown
  - requires metrics reset before the run
  - requires Replay Verifier output after the run

Escape hatches for rehearsal only:
  ALLOW_NON_BEIJING=1
  ALLOW_UNKNOWN_BUILD=1
  ALLOW_DIRTY_METRICS=1
  ALLOW_MISSING_VERIFY=1
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
role="${1:-}"
if [[ -z "$role" || "$role" == "-h" || "$role" == "--help" ]]; then
  usage
  exit 0
fi
shift

out_dir="${OUT_DIR:-}"
master_host="${MASTER_HOST:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    --master-host)
      master_host="${2:-}"
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
bid_command="${BID_COMMAND:-http}"
http_host="${HTTP_HOST:-$base_url}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$out_dir" ]]; then
  out_dir="/tmp/lumen-beijing-locust-${role}-${timestamp}"
fi
mkdir -p "$out_dir"

if [[ -z "$aid" ]]; then
  echo "LOAD_AUCTION_ID is required" >&2
  exit 2
fi
if [[ -z "$tokens_file" ]]; then
  echo "TOKENS_FILE is required" >&2
  exit 2
fi
require_file "$tokens_file" "TOKENS_FILE"
token_manifest "$tokens_file" "$out_dir/token-manifest.env"

case "$role" in
  master)
    need curl
    need jq
    users="${USERS:-10000}"
    spawn_rate="${SPAWN_RATE:-500}"
    run_time="${RUN_TIME:-180s}"
    expect_workers="${EXPECT_WORKERS:-8}"
    metrics_duration="${METRICS_DURATION_SEC:-240}"
    metrics_interval="${METRICS_INTERVAL_SEC:-5}"
    locust_dir="$out_dir/locust"
    metrics_dir="$out_dir/server-metrics-window"
    mkdir -p "$locust_dir" "$metrics_dir"

    {
      echo "role=master"
      echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "runner_region=${RUNNER_REGION:-}"
      echo "base_url=$base_url"
      echo "ws_host=$ws_host"
      echo "load_auction_id=$aid"
      echo "users=$users"
      echo "spawn_rate=$spawn_rate"
      echo "run_time=$run_time"
      echo "expect_workers=$expect_workers"
      echo "bid_command=$bid_command"
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
      --target "$users" \
      --out-dir "$metrics_dir" > "$out_dir/metrics-snapshot.log" 2>&1 &
    metrics_pid=$!

    csv_prefix="$locust_dir/beijing-locust"
    set +e
    LOAD_AUCTION_ID="$aid" TOKENS_FILE="$tokens_file" BID_COMMAND="$bid_command" HTTP_HOST="$http_host" \
      "$python_bin" -m locust \
        -f "$repo_root/tools/loadtest/locust_bidder_only.py" \
        --master \
        --headless \
        --expect-workers "$expect_workers" \
        --host "$ws_host" \
        -u "$users" \
        -r "$spawn_rate" \
        -t "$run_time" \
        --csv "$csv_prefix" \
        --html "$locust_dir/report.html" \
        2>&1 | tee "$locust_dir/master.log"
    locust_rc=${PIPESTATUS[0]}
    set -e

    wait "$metrics_pid" || true
    curl -fsS "$base_url/metrics" > "$out_dir/metrics-after-run.json" || true
    capture_host "after" "$out_dir"

    if [[ "$locust_rc" -ne 0 ]]; then
      echo "locust master failed with exit code $locust_rc" >&2
      exit "$locust_rc"
    fi
    "$python_bin" "$repo_root/tools/loadtest/locust_gate.py" \
      --stats "${csv_prefix}_stats.csv" \
      --out-dir "$out_dir/locust-gate" \
      --min-bid-ack "${MIN_BID_ACK:-1}" \
      --max-bid-ack-p95-ms "${MAX_CLIENT_BID_ACK_P95_MS:-1000}"

    REQUIRE_HAMMER="${REQUIRE_HAMMER:-0}" REQUIRE_CATCHUP="${REQUIRE_CATCHUP:-0}" \
      "$repo_root/scripts/remote-perf-gate.sh" \
        --server-metrics "$metrics_dir/metrics.json" \
        --target "$users" \
        --out-dir "$out_dir/server-gate"

    if [[ -n "${VERIFY_CMD:-}" ]]; then
      set +e
      LOAD_AUCTION_ID="$aid" sh -c "$VERIFY_CMD" > "$out_dir/replay-verifier.log" 2>&1
      verify_rc=$?
      set -e
      if [[ "$verify_rc" -ne 0 ]]; then
        echo "Replay Verifier command failed with exit code $verify_rc" >&2
        exit "$verify_rc"
      fi
    elif [[ "${ALLOW_MISSING_VERIFY:-0}" != "1" ]]; then
      echo "VERIFY_CMD is required for final evidence" >&2
      exit 2
    fi

    cat > "$out_dir/summary.md" <<EOF_SUMMARY
# Beijing-near Locust 10k evidence pack

- result: PASS
- base_url: $base_url
- ws_host: $ws_host
- runner_region: ${RUNNER_REGION:-}
- auction_id: $aid
- users: $users
- spawn_rate: $spawn_rate
- run_time: $run_time
- locust_gate: locust-gate/locust-gate.tsv
- server_gate: server-gate/gate.tsv
- metrics_window: server-metrics-window/metrics.json
- verifier: replay-verifier.log
EOF_SUMMARY
    echo "evidence_dir=$out_dir"
    ;;
  worker)
    if [[ -z "$master_host" ]]; then
      echo "--master-host or MASTER_HOST is required for worker role" >&2
      exit 2
    fi
    processes="${PROCESSES:-4}"
    capture_host "before" "$out_dir"
    set +e
    LOAD_AUCTION_ID="$aid" TOKENS_FILE="$tokens_file" BID_COMMAND="$bid_command" HTTP_HOST="$http_host" \
      "$python_bin" -m locust \
        -f "$repo_root/tools/loadtest/locust_bidder_only.py" \
        --worker \
        --master-host "$master_host" \
        --processes "$processes" \
        --host "$ws_host" \
        2>&1 | tee "$out_dir/worker.log"
    worker_rc=${PIPESTATUS[0]}
    set -e
    capture_host "after" "$out_dir"
    exit "$worker_rc"
    ;;
  *)
    echo "unknown role: $role" >&2
    usage >&2
    exit 2
    ;;
esac
