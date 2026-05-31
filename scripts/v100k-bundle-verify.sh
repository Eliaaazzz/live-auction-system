#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/v100k-bundle-verify.sh --bundle-dir DIR [--require-gate-pass]

Purpose:
  Verify a no-secret v100k artifact bundle produced by
  scripts/v100k-artifact-bundle.sh. This is an offline integrity and completeness
  check only; it does not run load tests and it does not create new evidence.

Checks:
  - MANIFEST.tsv exists and has the expected header.
  - Every manifest row points to a safe relative path inside the bundle.
  - Manifest byte counts and SHA-256 hashes match current file contents.
  - Required review files exist: summary.md, metrics/metrics.json,
    workers/shards.tsv.
  - If --require-gate-pass is set, gate/gate.tsv must exist and all status rows
    must be PASS.

Outputs:
  verification.tsv   check, status, detail
USAGE
}

bundle_dir=""
require_gate_pass="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-dir)
      bundle_dir="${2:-}"
      shift 2
      ;;
    --require-gate-pass)
      require_gate_pass="1"
      shift
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

if [ -z "$bundle_dir" ] || [ ! -d "$bundle_dir" ]; then
  echo "--bundle-dir must point to an existing artifact bundle directory" >&2
  usage >&2
  exit 2
fi

manifest="$bundle_dir/MANIFEST.tsv"
verification="$bundle_dir/verification.tsv"
tab=$(printf '\t')

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

record() {
  check_name="$1"
  status="$2"
  detail="$3"
  printf '%s\t%s\t%s\n' "$check_name" "$status" "$detail" >> "$verification"
}

safe_relpath() {
  rel="$1"
  case "$rel" in
    ""|/*|*../*|../*|*"/.."|"..")
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

require_file() {
  rel="$1"
  if [ -f "$bundle_dir/$rel" ]; then
    record "required_file:$rel" "PASS" "present"
  else
    record "required_file:$rel" "FAIL" "missing"
  fi
}

printf 'check\tstatus\tdetail\n' > "$verification"

if [ ! -f "$manifest" ]; then
  record "manifest_exists" "FAIL" "missing MANIFEST.tsv"
  printf 'result=FAIL\nbundle_dir=%s\nverification=%s\n' "$bundle_dir" "$verification"
  exit 1
fi
record "manifest_exists" "PASS" "present"

expected_header="file${tab}bytes${tab}sha256${tab}source"
header="$(awk 'NR == 1 { print; exit }' "$manifest")"
if [ "$header" = "$expected_header" ]; then
  record "manifest_header" "PASS" "expected header"
else
  record "manifest_header" "FAIL" "unexpected header"
fi

rows="$(awk 'END { print NR > 0 ? NR - 1 : 0 }' "$manifest")"
if [ "$rows" -gt 0 ]; then
  record "manifest_rows" "PASS" "$rows artifact rows"
else
  record "manifest_rows" "FAIL" "no artifact rows"
fi

rows_file="$(mktemp "${TMPDIR:-/tmp}/lumen-v100k-manifest-rows.XXXXXX")"
trap 'rm -f "$rows_file"' EXIT HUP INT TERM
awk 'NR > 1 { print }' "$manifest" > "$rows_file"

line_no=1
while IFS="$tab" read -r rel expected_bytes expected_sha source_path || [ -n "${rel:-}" ]; do
  line_no=$((line_no + 1))
  if [ -z "${rel:-}" ]; then
    record "manifest_row:$line_no" "FAIL" "missing file column"
    continue
  fi
  if [ -z "${expected_bytes:-}" ] || [ -z "${expected_sha:-}" ] || [ -z "${source_path:-}" ]; then
    record "manifest_row:$line_no" "FAIL" "expected four TSV columns"
    continue
  fi
  if ! safe_relpath "$rel"; then
    record "manifest_path:$rel" "FAIL" "unsafe relative path"
    continue
  fi

  path="$bundle_dir/$rel"
  if [ ! -f "$path" ]; then
    record "artifact_exists:$rel" "FAIL" "missing file"
    continue
  fi
  record "artifact_exists:$rel" "PASS" "present"

  actual_bytes="$(file_size "$path")"
  if [ "$actual_bytes" = "$expected_bytes" ]; then
    record "artifact_bytes:$rel" "PASS" "$actual_bytes"
  else
    record "artifact_bytes:$rel" "FAIL" "expected $expected_bytes got $actual_bytes"
  fi

  actual_sha="$(hash_file "$path")"
  if [ "$actual_sha" = "$expected_sha" ]; then
    record "artifact_sha256:$rel" "PASS" "$actual_sha"
  else
    record "artifact_sha256:$rel" "FAIL" "expected $expected_sha got $actual_sha"
  fi
done < "$rows_file"

require_file "summary.md"
require_file "metrics/metrics.json"
require_file "workers/shards.tsv"

if [ "$require_gate_pass" = "1" ]; then
  if [ ! -f "$bundle_dir/gate/gate.tsv" ]; then
    record "gate_required" "FAIL" "missing gate/gate.tsv"
  else
    gate_eval="$(awk -F '\t' '
      NR == 1 {
        for (i = 1; i <= NF; i++) {
          if ($i == "status") status_col = i
        }
        next
      }
      NR > 1 {
        rows++
        if (status_col == "" || $status_col != "PASS") bad++
      }
      END {
        if (status_col == "") print "MISSING_STATUS"
        else if (rows == 0) print "NO_ROWS"
        else print bad + 0
      }
    ' "$bundle_dir/gate/gate.tsv")"
    case "$gate_eval" in
      0)
        record "gate_all_pass" "PASS" "all gate rows PASS"
        ;;
      MISSING_STATUS)
        record "gate_all_pass" "FAIL" "missing status column"
        ;;
      NO_ROWS)
        record "gate_all_pass" "FAIL" "no gate rows"
        ;;
      *)
        record "gate_all_pass" "FAIL" "$gate_eval non-PASS gate rows"
        ;;
    esac
  fi
elif [ -f "$bundle_dir/gate/gate.tsv" ]; then
  record "gate_present" "PASS" "gate/gate.tsv present; use --require-gate-pass to enforce"
else
  record "gate_present" "SKIP" "gate not included"
fi

if awk -F '\t' 'NR > 1 && $2 == "FAIL" { found = 1 } END { exit found ? 0 : 1 }' "$verification"; then
  result="FAIL"
else
  result="PASS"
fi

printf 'result=%s\nbundle_dir=%s\nverification=%s\n' "$result" "$bundle_dir" "$verification"

if [ "$result" = "FAIL" ]; then
  exit 1
fi
