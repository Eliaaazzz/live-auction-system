#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-}"
OUT_DIR="${OUT_DIR:-/tmp/lumen-deploy-teardown-$(date -u +%Y%m%dT%H%M%SZ)}"
CURL_MAX_TIME="${CURL_MAX_TIME:-5}"

usage() {
  cat <<'USAGE'
usage: scripts/deploy-teardown-checklist.sh

Create a no-secret teardown evidence pack for a deployed rehearsal/demo run.
This is the A9 counterpart to deploy preflight: it helps operators prove that
load clients, temporary access, and billable cloud resources were shut down.

Environment:
  BASE_URL       optional deployed endpoint to probe after teardown
  OUT_DIR        output directory, default /tmp/lumen-deploy-teardown-<utc>
  CURL_MAX_TIME  curl timeout seconds, default 5

The script never reads .env files, cloud credentials, tokens, cookies, or API
keys. It does not call any cloud provider API; provider shutdown remains a
human console/CLI action recorded in the checklist.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

mkdir -p "${OUT_DIR}"

now_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf 'created_at_utc\t%s\n' "${now_utc}"
  printf 'base_url\t%s\n' "${BASE_URL:-unset}"
  printf 'host\t%s\n' "$(hostname 2>/dev/null || printf unknown)"
  printf 'note\t%s\n' 'no secrets read; no provider API called'
} >"${OUT_DIR}/manifest.tsv"

probe_url() {
  local name="$1"
  local url="$2"
  local body="${OUT_DIR}/${name}.body"
  local headers="${OUT_DIR}/${name}.headers"
  local code
  code="$(curl -k -sS -L --max-time "${CURL_MAX_TIME}" -D "${headers}" -o "${body}" -w '%{http_code}' "${url}" 2>"${OUT_DIR}/${name}.stderr" || true)"
  printf '%s\t%s\t%s\n' "${name}" "${url}" "${code:-curl_error}"
}

if [[ -n "${BASE_URL}" ]]; then
  base="${BASE_URL%/}"
  {
    printf 'name\turl\thttp_code\n'
    probe_url healthz "${base}/healthz"
    probe_url metrics "${base}/metrics"
    probe_url admin "${base}/admin.html"
    probe_url room "${base}/room.html?auction=auc_demo"
  } >"${OUT_DIR}/post_teardown_probe.tsv"
else
  printf 'BASE_URL not set; no endpoint probe executed.\n' >"${OUT_DIR}/post_teardown_probe.tsv"
fi

cat >"${OUT_DIR}/checklist.md" <<'CHECKLIST'
# Lumen deploy teardown checklist

Purpose: prove the deployed rehearsal/demo path was safely shut down after the
#121 production/real-network run, without recording secrets or cloud tokens.

## 1. Stop load generators

- [ ] Stop k6 / Locust / wsload clients on every runner host.
- [ ] Capture final client summaries and copy them into the demo evidence pack.
- [ ] Confirm no runner process is still opening WebSocket connections.

## 2. Capture final service evidence before shutdown

- [ ] Save `/metrics` snapshot from the deployed endpoint.
- [ ] Save `make verify` / `make verify-evidence` output for the tested auction.
- [ ] Save deployment commit SHA, image tag, and run window in the report.

## 3. Remove temporary access

- [ ] Remove temporary security-group ingress opened for load runners.
- [ ] Disable or delete temporary rehearsal tokens/accounts.
- [ ] Confirm `ENABLE_DEV_LOGIN=false` remains true in production config.
- [ ] Rotate any credential that was manually exposed during rehearsal.

## 4. Stop billable resources

- [ ] Stop or destroy ECS/VM instances that are not needed after the demo.
- [ ] Stop or release managed MySQL if no longer needed; snapshot first if required.
- [ ] Stop or release managed Redis if no longer needed; preserve AOF/snapshot only if required.
- [ ] Stop Caddy/prod compose services on the VM before releasing the VM.
- [ ] Stop live-video push sessions and disable unused live domains/services if billing applies.

## 5. Verify shutdown

- [ ] Deployed `BASE_URL` is no longer serving the app, or is intentionally left live with owner approval.
- [ ] Cloud billing console shows no unexpected running resources.
- [ ] DNS / CNAME records left behind are documented, or removed if no longer needed.
- [ ] Local Docker fallback remains available for the final demo path.

## 6. Residual ownership

- [ ] Record who owns any resource intentionally left running.
- [ ] Record the date/time it must be stopped.
- [ ] Link this teardown pack from the #121 issue comment.
CHECKLIST

cat >"${OUT_DIR}/README.md" <<EOF_README
# Lumen deploy teardown evidence

Created: ${now_utc}

Files:
- manifest.tsv: run metadata
- checklist.md: human A9 shutdown checklist
- post_teardown_probe.tsv: optional BASE_URL probe results
- *.headers / *.body / *.stderr: captured endpoint probe artifacts when BASE_URL is set

This pack is intentionally no-secret. It never reads .env files or cloud
credentials and never calls cloud provider APIs.
EOF_README

printf 'teardown evidence pack: %s\n' "${OUT_DIR}"
