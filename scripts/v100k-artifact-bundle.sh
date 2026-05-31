#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/v100k-artifact-bundle.sh --metrics-dir DIR --shards FILE [--gate-dir DIR] [--out-dir DIR]

Purpose:
  Assemble the no-secret artifacts from a distributed v100k run into one review
  bundle. This is a packaging helper only; it does not run the load test and it
  does not decide pass/fail. The authoritative gate remains
  scripts/v100k-evidence-gate.sh.

Required inputs:
  --metrics-dir DIR   Directory from v100k-metrics-snapshot.sh.
                      Must contain metrics.json.
  --shards FILE       shards.tsv from wsload/summarize-workers.sh.

Optional inputs:
  --gate-dir DIR      Evidence directory from v100k-evidence-gate.sh.
                      When provided, gate.tsv and summary.md are included.
  --out-dir DIR       Bundle output directory. Defaults under /tmp.

Outputs:
  MANIFEST.tsv        file, bytes, sha256, and source path for copied artifacts.
  summary.md          bundle index and claim-boundary reminder.

The helper intentionally copies only aggregate evidence files. It does not copy
token shards, per-worker raw logs, .env files, or credentials.
USAGE
}

metrics_dir=""
shards_file=""
gate_dir=""
out_dir=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --metrics-dir)
      metrics_dir="${2:-}"
      shift 2
      ;;
    --shards)
      shards_file="${2:-}"
      shift 2
      ;;
    --gate-dir)
      gate_dir="${2:-}"
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

if [ -z "$metrics_dir" ] || [ ! -d "$metrics_dir" ]; then
  echo "--metrics-dir must point to an existing metrics snapshot directory" >&2
  usage >&2
  exit 2
fi
if [ ! -f "$metrics_dir/metrics.json" ]; then
  echo "--metrics-dir must contain metrics.json: $metrics_dir" >&2
  exit 2
fi
if [ -z "$shards_file" ] || [ ! -f "$shards_file" ]; then
  echo "--shards must point to an existing shards.tsv file" >&2
  usage >&2
  exit 2
fi
if [ -n "$gate_dir" ] && [ ! -d "$gate_dir" ]; then
  echo "--gate-dir must point to an existing gate evidence directory" >&2
  exit 2
fi
if [ -n "$gate_dir" ] && [ ! -f "$gate_dir/gate.tsv" ]; then
  echo "--gate-dir must contain gate.tsv: $gate_dir" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash_file() {
    sha256sum "$1" | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
else
  echo "sha256sum or shasum is required" >&2
  exit 2
fi

file_size() {
  if stat -f %z "$1" >/dev/null 2>&1; then
    stat -f %z "$1"
  else
    stat -c %s "$1"
  fi
}

if [ -z "$out_dir" ]; then
  out_dir="/tmp/lumen-v100k-artifact-bundle-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$out_dir"

manifest="$out_dir/MANIFEST.tsv"
summary="$out_dir/summary.md"
printf 'file\tbytes\tsha256\tsource\n' > "$manifest"

copy_artifact() {
  src_path="$1"
  dest_rel="$2"
  dest_path="$out_dir/$dest_rel"
  mkdir -p "$(dirname "$dest_path")"
  cp "$src_path" "$dest_path"
  bytes="$(file_size "$dest_path")"
  sha="$(hash_file "$dest_path")"
  printf '%s\t%s\t%s\t%s\n' "$dest_rel" "$bytes" "$sha" "$src_path" >> "$manifest"
}

copy_if_present() {
  src_path="$1"
  dest_rel="$2"
  if [ -f "$src_path" ]; then
    copy_artifact "$src_path" "$dest_rel"
  fi
}

copy_artifact "$metrics_dir/metrics.json" "metrics/metrics.json"
copy_if_present "$metrics_dir/metrics-samples.jsonl" "metrics/metrics-samples.jsonl"
copy_if_present "$metrics_dir/summary.md" "metrics/summary.md"
copy_artifact "$shards_file" "workers/shards.tsv"

gate_status="not_provided"
if [ -n "$gate_dir" ]; then
  copy_artifact "$gate_dir/gate.tsv" "gate/gate.tsv"
  copy_if_present "$gate_dir/summary.md" "gate/summary.md"
  if [ -f "$gate_dir/summary.md" ]; then
    gate_status="$(awk -F ': ' '/^Result:/ { print $2; found = 1; exit } END { if (!found) print "unknown" }' "$gate_dir/summary.md")"
  else
    gate_status="unknown"
  fi
fi

cat > "$summary" <<EOF_SUMMARY
# Lumen v100k artifact bundle

- created_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- bundle_dir: $out_dir
- metrics_dir: $metrics_dir
- shards_file: $shards_file
- gate_dir: ${gate_dir:-not provided}
- gate_result: $gate_status
- manifest: $manifest

Included files:

- metrics/metrics.json
- metrics/metrics-samples.jsonl, when present
- metrics/summary.md, when present
- workers/shards.tsv
- gate/gate.tsv and gate/summary.md, when a gate directory is provided

Claim boundary:

- This bundle is evidence packaging only.
- A 100k claim requires the authoritative gate result in gate/gate.tsv.
- If the gate is missing or FAIL, the honest external claim remains: 10k verified;
  100k not yet verified.
- This bundle intentionally excludes token shards, raw worker logs, .env files,
  credentials, and cloud provider state.
EOF_SUMMARY

summary_bytes="$(file_size "$summary")"
summary_sha="$(hash_file "$summary")"
printf '%s\t%s\t%s\t%s\n' "summary.md" "$summary_bytes" "$summary_sha" "$summary" >> "$manifest"

printf 'bundle_dir=%s\nmanifest=%s\nsummary=%s\ngate_result=%s\n' \
  "$out_dir" "$manifest" "$summary" "$gate_status"
