#!/usr/bin/env bash
set -euo pipefail

# Project-wide reviewer status snapshot:
# - emits current open PR/Issue counts
# - emits explicit blockers (from review-blocker-digest)
# - supports machine output for CI or dashboard ingestion
#
# Usage:
#   scripts/review-project-status.sh [options] [repo] [prLimit] [issueLimit] [issueStaleDays]
# Example:
#   scripts/review-project-status.sh github.com/Eliaaazzz/live-auction-system 30 50 3

usage() {
  cat <<'EOF'
Usage:
  scripts/review-project-status.sh [options] [repo] [prLimit] [issueLimit] [issueStaleDays]

Options:
  --json        emit machine-readable JSON payload at the end
  --json-only   emit only JSON (implies --json)
  --strict      exit with code 2 when any blocking issue is present
  -h, --help   show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
PR_LIMIT=30
ISSUE_LIMIT=50
ISSUE_STALE_DAYS=3
OUTPUT_JSON=0
JSON_ONLY=0
STRICT_MODE=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --json-only)
      OUTPUT_JSON=1
      JSON_ONLY=1
      shift
      ;;
    --strict)
      STRICT_MODE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "unknown flag: $1"
      usage
      exit 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ "${#POSITIONAL[@]}" -ge 1 ]]; then
  REPO="${POSITIONAL[0]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 2 ]]; then
  PR_LIMIT="${POSITIONAL[1]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 3 ]]; then
  ISSUE_LIMIT="${POSITIONAL[2]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 4 ]]; then
  ISSUE_STALE_DAYS="${POSITIONAL[3]}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if (( OUTPUT_JSON == 1 && JSON_ONLY == 1 )); then
  exec 7>&1
  exec > /dev/null
  json_output_fd=7
else
  json_output_fd=1
fi

if (( OUTPUT_JSON == 1 )); then
  pr_payload="$($SCRIPT_DIR/review-open-prs.sh --json-only "$REPO" "$PR_LIMIT")"
  issue_payload="$($SCRIPT_DIR/review-open-issues.sh --json-only "$REPO" "$ISSUE_LIMIT" "$ISSUE_STALE_DAYS")"
  blocker_payload="$($SCRIPT_DIR/review-blocker-digest.sh --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$ISSUE_STALE_DAYS")"
else
  pr_payload="$($SCRIPT_DIR/review-open-prs.sh "$REPO" "$PR_LIMIT" --json-only)"
  issue_payload="$($SCRIPT_DIR/review-open-issues.sh "$REPO" "$ISSUE_LIMIT" "$ISSUE_STALE_DAYS" --json-only)"
  blocker_payload="$($SCRIPT_DIR/review-blocker-digest.sh "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$ISSUE_STALE_DAYS" --json-only)"
fi

if ! jq -e '.open_prs|type=="array"' <<<"$pr_payload" >/dev/null; then
  echo "failed to parse PR payload"
  exit 1
fi
if ! jq -e '.open_issues|type=="array"' <<<"$issue_payload" >/dev/null; then
  echo "failed to parse issue payload"
  exit 1
fi
if ! jq -e '.summary.blocking_prs as $a | .summary.unassigned_no_open_pr_link_alerts as $b | ($a|type=="number") and ($b|type=="number")' <<<"$blocker_payload" >/dev/null; then
  echo "failed to parse blocker payload"
  exit 1
fi

open_pr_count="$(jq '.count' <<<"$pr_payload")"
open_issue_count="$(jq '.count' <<<"$issue_payload")"
blocking_pr_count="$(jq '.summary.blocking_prs' <<<"$blocker_payload")"
stale_unassigned_issue_count="$(jq '.summary.stale_unassigned_issue_alerts' <<<"$blocker_payload")"
unassigned_no_open_pr_link_count="$(jq '.summary.unassigned_no_open_pr_link_alerts' <<<"$blocker_payload")"
total_blockers="$(jq '.summary.blocking_prs + .summary.stale_unassigned_issue_alerts + .summary.unassigned_no_open_pr_link_alerts' <<<"$blocker_payload")"

if [[ "$OUTPUT_JSON" == "1" ]]; then
  jq -nc \
    --arg repo "$REPO" \
    --argjson openPrCount "$open_pr_count" \
    --argjson openIssueCount "$open_issue_count" \
    --argjson blockingPrCount "$blocking_pr_count" \
    --argjson staleUnassignedIssueCount "$stale_unassigned_issue_count" \
    --argjson unassignedNoPrLinkIssueCount "$unassigned_no_open_pr_link_count" \
    --argjson totalBlockers "$total_blockers" \
    --argjson prs "$pr_payload" \
    --argjson issues "$issue_payload" \
    --argjson blockers "$blocker_payload" \
    '{
      repo: $repo,
      generated_at: (now | todateiso8601),
      counts: {
        open_prs: $openPrCount,
        open_issues: $openIssueCount,
        blocking_prs: $blockingPrCount,
        stale_unassigned_issue_alerts: $staleUnassignedIssueCount,
        unassigned_no_open_pr_link_alerts: $unassignedNoPrLinkIssueCount,
        blocking_total: $totalBlockers
      },
      open_prs: $prs.open_prs,
      open_issues: $issues.open_issues,
      blockers: $blockers
    }' >&$json_output_fd
else
  echo "Project status snapshot (${REPO})"
  echo "open PRs: ${open_pr_count} | open issues: ${open_issue_count}"
  echo "blocking PRs: ${blocking_pr_count} | stale unassigned issues: ${stale_unassigned_issue_count} | no-open-pr issues: ${unassigned_no_open_pr_link_count} | total blockers: ${total_blockers}"
fi

if (( STRICT_MODE == 1 )) && (( total_blockers > 0 )); then
  echo "blocking items detected: ${total_blockers}" >&$json_output_fd
  exit 2
fi

exit 0
