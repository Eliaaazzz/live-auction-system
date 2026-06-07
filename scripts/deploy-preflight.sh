#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
AID="${AID:-auc_demo}"
OUT_DIR="${OUT_DIR:-/tmp/lumen-deploy-preflight-$(date -u +%Y%m%dT%H%M%SZ)}"
MAX_TIME="${MAX_TIME:-10}"
ALLOW_FAILURE="${ALLOW_FAILURE:-0}"
EXPECTED_BUILD_SHA="${EXPECTED_BUILD_SHA:-${EXPECTED_COMMIT:-}}"
MODEL_SCHEMA_VERSION="$(sed -nE 's/^const[[:space:]]+SchemaVersion[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' apps/lumen/internal/model/model.go 2>/dev/null | head -n 1 || true)"
EXPECTED_SCHEMA_VERSION="${EXPECTED_SCHEMA_VERSION:-$MODEL_SCHEMA_VERSION}"
REQUIRE_VERSION_IDENTITY="${REQUIRE_VERSION_IDENTITY:-0}"

mkdir -p "$OUT_DIR"

STATUS_FILE="$OUT_DIR/status.tsv"
MANIFEST_FILE="$OUT_DIR/manifest.txt"
METRICS_SUMMARY="$OUT_DIR/metrics-summary.json"
VERSION_SUMMARY="$OUT_DIR/version-summary.json"

printf "check\texit_code\thttp_code\tartifact\n" > "$STATUS_FILE"

failures=0

ws_url="$BASE_URL"
case "$ws_url" in
  https://*) ws_url="wss://${ws_url#https://}" ;;
  http://*) ws_url="ws://${ws_url#http://}" ;;
esac

{
  echo "lumen deploy preflight"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "base_url=$BASE_URL"
  echo "derived_ws_url=$ws_url/ws"
  echo "auction_id=$AID"
  echo "expected_schema_version=$EXPECTED_SCHEMA_VERSION"
  echo "expected_build_sha=$EXPECTED_BUILD_SHA"
  echo "require_version_identity=$REQUIRE_VERSION_IDENTITY"
  echo "out_dir=$OUT_DIR"
  echo "max_time=$MAX_TIME"
  if command -v git >/dev/null 2>&1; then
    echo "git_head=$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
    echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
  fi
  echo
  echo "This preflight reads only public HTTP endpoints and does not inspect secrets."
} > "$MANIFEST_FILE"

record_http() {
  local name="$1"
  local path="$2"
  local want_prefix="$3"
  local dir="$OUT_DIR/$name"
  local url="$BASE_URL$path"
  local rc
  local http_code

  mkdir -p "$dir"
  echo "==> $name $url"

  set +e
  http_code="$(curl -sS -L --max-time "$MAX_TIME" \
    -D "$dir/headers.txt" \
    -o "$dir/body.txt" \
    -w "%{http_code}" \
    "$url" 2>"$dir/stderr.txt")"
  rc=$?
  set -e

  printf "%s\t%d\t%s\t%s\n" "$name" "$rc" "$http_code" "$dir" >> "$STATUS_FILE"

  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> $name curl failed with exit code $rc"
    return
  fi

  case "$http_code" in
    "$want_prefix"*) ;;
    *)
      failures=$((failures + 1))
      echo "==> $name expected HTTP ${want_prefix}xx, got $http_code"
      ;;
  esac
}

record_check() {
  local name="$1"
  local rc="$2"
  local artifact="$3"
  local detail="${4:-}"

  printf "%s\t%d\t%s\t%s\n" "$name" "$rc" "n/a" "$artifact" >> "$STATUS_FILE"
  if [ "$rc" -ne 0 ]; then
    failures=$((failures + 1))
    echo "==> $name failed${detail:+: $detail}"
  fi
}

json_field() {
  local file="$1"
  local field="$2"

  if command -v jq >/dev/null 2>&1; then
    jq -r ".$field // empty" "$file"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$field" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)

value = data
for part in sys.argv[2].split("."):
    if isinstance(value, dict):
        value = value.get(part, "")
    else:
        value = ""
        break

print("" if value is None else value)
PY
    return
  fi

  if command -v python >/dev/null 2>&1; then
    python - "$file" "$field" <<'PY'
import json
import sys

with open(sys.argv[1]) as f:
    data = json.load(f)

value = data
for part in sys.argv[2].split("."):
    if isinstance(value, dict):
        value = value.get(part, "")
    else:
        value = ""
        break

print("" if value is None else value)
PY
    return
  fi

  sed -nE "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"?([^\",}]*)\"?.*/\1/p" "$file" | head -n 1
}

record_http "healthz" "/healthz" "2"
record_http "version" "/version" "2"
record_http "metrics" "/metrics" "2"
record_http "admin" "/admin.html" "2"
record_http "room" "/room.html?auction=$AID" "2"

if [ -s "$OUT_DIR/version/body.txt" ]; then
  if command -v jq >/dev/null 2>&1; then
    jq '{status, schemaVersion, buildSha, buildTime, appEnv}' \
      "$OUT_DIR/version/body.txt" > "$VERSION_SUMMARY" 2>/dev/null || cp "$OUT_DIR/version/body.txt" "$VERSION_SUMMARY"
  else
    cp "$OUT_DIR/version/body.txt" "$VERSION_SUMMARY"
  fi

  version_schema="$(json_field "$OUT_DIR/version/body.txt" "schemaVersion" || true)"
  version_build_sha="$(json_field "$OUT_DIR/version/body.txt" "buildSha" || true)"
  version_build_time="$(json_field "$OUT_DIR/version/body.txt" "buildTime" || true)"

  if [ -n "$EXPECTED_SCHEMA_VERSION" ]; then
    if [ "$version_schema" = "$EXPECTED_SCHEMA_VERSION" ]; then
      record_check "version_schema_check" 0 "$VERSION_SUMMARY"
    else
      record_check "version_schema_check" 1 "$VERSION_SUMMARY" "schemaVersion=$version_schema expected $EXPECTED_SCHEMA_VERSION"
    fi
  fi

  if [ -n "$EXPECTED_BUILD_SHA" ]; then
    if [ "$version_build_sha" = "$EXPECTED_BUILD_SHA" ]; then
      record_check "version_build_sha_check" 0 "$VERSION_SUMMARY"
    else
      record_check "version_build_sha_check" 1 "$VERSION_SUMMARY" "buildSha=$version_build_sha expected $EXPECTED_BUILD_SHA"
    fi
  elif [ "$REQUIRE_VERSION_IDENTITY" = "1" ]; then
    if [ -n "$version_build_sha" ] && [ "$version_build_sha" != "unknown" ]; then
      record_check "version_build_sha_check" 0 "$VERSION_SUMMARY"
    else
      record_check "version_build_sha_check" 1 "$VERSION_SUMMARY" "buildSha must be non-unknown"
    fi
  fi

  if [ "$REQUIRE_VERSION_IDENTITY" = "1" ]; then
    if [ -n "$version_build_time" ] && [ "$version_build_time" != "unknown" ]; then
      record_check "version_build_time_check" 0 "$VERSION_SUMMARY"
    else
      record_check "version_build_time_check" 1 "$VERSION_SUMMARY" "buildTime must be non-unknown"
    fi
  fi
fi

if [ -s "$OUT_DIR/metrics/body.txt" ]; then
  if command -v jq >/dev/null 2>&1; then
    jq '{activeConns, ackLatencyMs, broadcastLatencyMs, seqGapCount, backpressureForceClose}' \
      "$OUT_DIR/metrics/body.txt" > "$METRICS_SUMMARY" 2>/dev/null || true
  else
    cp "$OUT_DIR/metrics/body.txt" "$METRICS_SUMMARY"
  fi
fi

{
  echo
  echo "status_file=$STATUS_FILE"
  echo "metrics_summary=$METRICS_SUMMARY"
  echo "version_summary=$VERSION_SUMMARY"
  echo "failed_checks=$failures"
  echo "room_url=$BASE_URL/room.html?auction=$AID"
} >> "$MANIFEST_FILE"

echo "preflight pack:  $OUT_DIR"
echo "manifest:        $MANIFEST_FILE"
echo "status:          $STATUS_FILE"
echo "metrics summary: $METRICS_SUMMARY"

if [ "$failures" -ne 0 ] && [ "$ALLOW_FAILURE" != "1" ]; then
  exit 1
fi
