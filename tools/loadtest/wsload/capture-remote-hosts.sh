#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tools/loadtest/wsload/capture-remote-hosts.sh \
    --hosts worker-hosts.tsv \
    --stage before|hold|after|custom \
    --out-dir DIR \
    [--ssh-key FILE] \
    [--ssh-option ARG]

The hosts file is TSV/space-delimited: <name> <ssh_target>. It writes one
no-secret snapshot per host as <out-dir>/host-<name>-<stage>.txt.
USAGE
}

hosts_file=""
stage=""
out_dir=""
ssh_key=""
ssh_options=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)
      hosts_file="${2:-}"
      shift 2
      ;;
    --stage)
      stage="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    --ssh-key)
      ssh_key="${2:-}"
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

need ssh

if [[ -z "$hosts_file" || ! -f "$hosts_file" ]]; then
  echo "--hosts must point to a host file" >&2
  exit 2
fi
if [[ -z "$stage" ]]; then
  echo "--stage is required" >&2
  exit 2
fi
if [[ -z "$out_dir" ]]; then
  echo "--out-dir is required" >&2
  exit 2
fi
if [[ -n "$ssh_key" && ! -f "$ssh_key" ]]; then
  echo "--ssh-key not found: $ssh_key" >&2
  exit 2
fi
mkdir -p "$out_dir"

ssh_base=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
if [[ -n "$ssh_key" ]]; then
  ssh_base+=(-i "$ssh_key")
fi
for opt in "${ssh_options[@]}"; do
  ssh_base+=(-o "$opt")
done

shell_quote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

snapshot_script() {
  local name="$1"
  cat <<EOF_CAPTURE
echo "stage=$stage"
date -u '+captured_at_utc=%Y-%m-%dT%H:%M:%SZ'
echo "host_id=$name"
echo "hostname=\$(hostname 2>/dev/null || true)"
echo "ulimit_n=\$(ulimit -n 2>/dev/null || true)"
uname -a 2>/dev/null || true
nproc 2>/dev/null || true
free -m 2>/dev/null || true
df -h 2>/dev/null || true
ss -s 2>/dev/null || true
ip addr 2>/dev/null || true
ip route 2>/dev/null || true
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog net.ipv4.ip_local_port_range 2>/dev/null || true
ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -40 || true
EOF_CAPTURE
}

failures=0
while read -r name ssh_target _rest; do
  [[ -z "${name:-}" || "${name:0:1}" == "#" ]] && continue
  if [[ "$name" =~ ^[0-9]+$ ]]; then
    printf -v name '%02d' "$((10#$name))"
  fi
  if [[ -z "${ssh_target:-}" ]]; then
    echo "missing ssh target for host $name in $hosts_file" >&2
    failures=$((failures + 1))
    continue
  fi

  out_file="$out_dir/host-$name-$stage.txt"
  script="$(snapshot_script "$name")"
  if ! "${ssh_base[@]}" "$ssh_target" "sh -lc $(shell_quote "$script")" > "$out_file" 2>&1; then
    echo "failed to capture $stage snapshot for $name ($ssh_target)" >&2
    failures=$((failures + 1))
  fi
done < "$hosts_file"

if [[ "$failures" -gt 0 ]]; then
  exit 1
fi
