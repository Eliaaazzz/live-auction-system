#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tools/loadtest/wsload/run-remote-workers.sh \
    --plan /tmp/lumen-wsload-shards-*/workers.tsv \
    --hosts workers-hosts.tsv \
    --bin ./tools/loadtest/wsload/wsload-linux \
    --host ws://<gateway-private-or-lb>:80 \
    --aid auc_...

Required inputs:
  --plan FILE       workers.tsv from split-tokens.sh.
  --hosts FILE      TSV/space file: worker ssh_target
                    Example:
                      00 root@10.0.1.21
                      01 root@10.0.1.22
  --bin FILE        local Linux wsload binary to upload.
  --host URL        WS target each worker dials.
  --aid ID          LIVE auction id.

Optional:
  --ssh-key FILE    SSH private key path. If omitted, ssh default identities apply.
  --remote-dir DIR  Remote work directory. Default: /tmp/lumen-wsload-worker
  --logs-dir DIR    Local aggregate logs. Default: <plan-dir>/remote-worker-logs
  --ramp DURATION   Override ramp. Default: summary.env or 120s.
  --hold DURATION   Override hold. Default: summary.env or 180s.
  --ssh-option ARG  Extra ssh/scp option; can be repeated.

Output:
  <logs-dir>/worker-NN.log  per-worker wsload output
  <logs-dir>/host-NN-before.txt and host-NN-after.txt  per-worker host snapshots
  <logs-dir>/shards.tsv     aggregate summary for v100k-evidence-gate.sh

This helper does not print token values. It copies each worker's shard to only
that worker, removes the remote shard after the run, and stores aggregate wsload
logs locally.
USAGE
}

plan=""
hosts_file=""
bin=""
host=""
aid=""
ssh_key=""
remote_dir="/tmp/lumen-wsload-worker"
logs_dir=""
ramp=""
hold=""
ssh_options=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      plan="${2:-}"
      shift 2
      ;;
    --hosts)
      hosts_file="${2:-}"
      shift 2
      ;;
    --bin)
      bin="${2:-}"
      shift 2
      ;;
    --host)
      host="${2:-}"
      shift 2
      ;;
    --aid)
      aid="${2:-}"
      shift 2
      ;;
    --ssh-key)
      ssh_key="${2:-}"
      shift 2
      ;;
    --remote-dir)
      remote_dir="${2:-}"
      shift 2
      ;;
    --logs-dir)
      logs_dir="${2:-}"
      shift 2
      ;;
    --ramp)
      ramp="${2:-}"
      shift 2
      ;;
    --hold)
      hold="${2:-}"
      shift 2
      ;;
    --ssh-option)
      ssh_options+=("${2:-}")
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

need awk
need scp
need ssh

if [[ -z "$plan" || ! -f "$plan" ]]; then
  echo "--plan must point to workers.tsv" >&2
  exit 2
fi
if [[ -z "$hosts_file" || ! -f "$hosts_file" ]]; then
  echo "--hosts must point to a worker host file" >&2
  exit 2
fi
if [[ -z "$bin" || ! -f "$bin" ]]; then
  echo "--bin must point to a local Linux wsload binary" >&2
  exit 2
fi
if [[ -z "$host" ]]; then
  echo "--host is required" >&2
  exit 2
fi
if [[ -z "$aid" ]]; then
  echo "--aid is required" >&2
  exit 2
fi
if [[ -n "$ssh_key" && ! -f "$ssh_key" ]]; then
  echo "--ssh-key not found: $ssh_key" >&2
  exit 2
fi

plan_dir="$(cd "$(dirname "$plan")" && pwd)"
summary_env="$plan_dir/summary.env"
logs_dir="${logs_dir:-$plan_dir/remote-worker-logs}"
mkdir -p "$logs_dir"

if [[ -f "$summary_env" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      ramp) ramp="${ramp:-$value}" ;;
      hold) hold="${hold:-$value}" ;;
    esac
  done < "$summary_env"
fi
ramp="${ramp:-120s}"
hold="${hold:-180s}"

ssh_base=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
scp_base=(scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
if [[ -n "$ssh_key" ]]; then
  ssh_base+=(-i "$ssh_key")
  scp_base+=(-i "$ssh_key")
fi
for opt in "${ssh_options[@]}"; do
  ssh_base+=(-o "$opt")
  scp_base+=(-o "$opt")
done

shell_quote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

capture_remote_host() {
  local worker="$1"
  local ssh_target="$2"
  local stage="$3"
  local out_file="$4"
  local script

  script=$(cat <<EOF_CAPTURE
echo "stage=$stage"
date -u '+captured_at_utc=%Y-%m-%dT%H:%M:%SZ'
echo "worker=$worker"
echo "hostname=\$(hostname 2>/dev/null || true)"
echo "ulimit_n=\$(ulimit -n 2>/dev/null || true)"
uname -a 2>/dev/null || true
nproc 2>/dev/null || true
free -m 2>/dev/null || true
df -h 2>/dev/null || true
ss -s 2>/dev/null || true
ip addr 2>/dev/null || true
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog net.ipv4.ip_local_port_range 2>/dev/null || true
ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -40 || true
EOF_CAPTURE
)
  "${ssh_base[@]}" "$ssh_target" "sh -lc $(shell_quote "$script")" > "$out_file" 2>&1
}

plan_lookup() {
  local worker="$1"
  awk -F '\t' -v worker="$worker" '
    NR == 1 { next }
    $1 == worker { print $3 "\t" $4 "\t" $5; found = 1; exit }
    END { if (!found) exit 1 }
  ' "$plan"
}

remote_pids=()
workers_started="$logs_dir/workers-started.tsv"
printf 'worker\tssh_target\tconns\tbidders\tlog\n' > "$workers_started"

while read -r worker ssh_target _rest; do
  [[ -z "${worker:-}" || "${worker:0:1}" == "#" ]] && continue
  if [[ "$worker" =~ ^[0-9]+$ ]]; then
    printf -v worker '%02d' "$((10#$worker))"
  fi
  if [[ -z "${ssh_target:-}" ]]; then
    echo "missing ssh target for worker $worker in $hosts_file" >&2
    exit 2
  fi

  row="$(plan_lookup "$worker" || true)"
  if [[ -z "$row" ]]; then
    echo "worker $worker not found in plan $plan" >&2
    exit 2
  fi
  IFS=$'\t' read -r conns bidders token_file <<< "$row"
  if [[ ! -f "$token_file" ]]; then
    echo "token shard for worker $worker not found: $token_file" >&2
    exit 2
  fi

  worker_remote_dir="$remote_dir/worker-$worker"
  local_log="$logs_dir/worker-$worker.log"
  host_before="$logs_dir/host-$worker-before.txt"
  host_after="$logs_dir/host-$worker-after.txt"
  remote_token="$worker_remote_dir/tokens-worker-$worker.txt"
  remote_bin="$worker_remote_dir/wsload"
  remote_log="$worker_remote_dir/worker-$worker.log"
  remote_rc="$worker_remote_dir/wsload.rc"

  "${ssh_base[@]}" "$ssh_target" "mkdir -p $(shell_quote "$worker_remote_dir")"
  "${scp_base[@]}" "$bin" "$ssh_target:$remote_bin"
  "${scp_base[@]}" "$token_file" "$ssh_target:$remote_token"
  "${ssh_base[@]}" "$ssh_target" "chmod 700 $(shell_quote "$remote_bin")"
  capture_remote_host "$worker" "$ssh_target" "before" "$host_before"

  {
    echo "worker=$worker"
    echo "ssh_target=$ssh_target"
    echo "target_conns=$((conns + bidders))"
    echo "conns=$conns"
    echo "bidders=$bidders"
    echo "host=$host"
    echo "aid=$aid"
    echo "ramp=$ramp"
    echo "hold=$hold"
    echo "remote_dir=$worker_remote_dir"
    echo "host_before=$host_before"
    echo "host_after=$host_after"
    echo "started_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$local_log"

  remote_cmd=$(cat <<EOF_REMOTE
cd $(shell_quote "$worker_remote_dir") || exit 1
cleanup_worker_secret() {
  rm -f -- $(shell_quote "$remote_token")
}
trap cleanup_worker_secret EXIT INT TERM
(
  ulimit -n 200000 2>/dev/null || ulimit -n 65535 2>/dev/null || true
  echo "effective_ulimit_n=\$(ulimit -n 2>/dev/null || true)"
  $(shell_quote "$remote_bin") -host $(shell_quote "$host") -aid $(shell_quote "$aid") -tokens $(shell_quote "$remote_token") -conns $(shell_quote "$conns") -bidders $(shell_quote "$bidders") -ramp $(shell_quote "$ramp") -hold $(shell_quote "$hold")
  printf '%s\n' "\$?" > $(shell_quote "$remote_rc")
) 2>&1 | tee $(shell_quote "$remote_log")
run_rc=\$(cat $(shell_quote "$remote_rc") 2>/dev/null || printf '1')
cleanup_worker_secret
exit "\$run_rc"
EOF_REMOTE
)
  "${ssh_base[@]}" "$ssh_target" "$remote_cmd" >> "$local_log" 2>&1 &
  remote_pids+=("$!")
  printf '%s\t%s\t%s\t%s\t%s\n' "$worker" "$ssh_target" "$conns" "$bidders" "$local_log" >> "$workers_started"
done < "$hosts_file"

if [[ "${#remote_pids[@]}" -eq 0 ]]; then
  echo "no workers found in $hosts_file" >&2
  exit 2
fi

failures=0
for pid in "${remote_pids[@]}"; do
  if ! wait "$pid"; then
    failures=$((failures + 1))
  fi
done

while IFS=$'\t' read -r worker ssh_target conns bidders local_log; do
  [[ "$worker" == "worker" || -z "${worker:-}" ]] && continue
  if ! capture_remote_host "$worker" "$ssh_target" "after" "$logs_dir/host-$worker-after.txt"; then
    echo "failed to capture after-host snapshot for worker $worker" >&2
    failures=$((failures + 1))
  fi
done < "$workers_started"

"$(dirname "$0")/summarize-workers.sh" \
  --plan "$plan" \
  --logs-dir "$logs_dir" \
  --out "$logs_dir/shards.tsv" || failures=$((failures + 1))

echo "remote worker logs: $logs_dir"
echo "worker starts: $workers_started"
echo "shards summary: $logs_dir/shards.tsv"

if [[ "$failures" -gt 0 ]]; then
  echo "remote worker failures=$failures" >&2
  exit 1
fi
