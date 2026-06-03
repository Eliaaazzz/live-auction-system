#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Review script smoke test:
# - Runs core reviewer scripts in JSON mode
# - Validates JSON shape and basic invariants
# - Returns non-zero when any contract breaks
#
# Usage:
#   scripts/review-smoke.sh [repo] [prLimit] [issueLimit] [staleDays]
# Example:
#   scripts/review-smoke.sh github.com/Eliaaazzz/live-auction-system 20 80 3

REPO="github.com/Eliaaazzz/live-auction-system"
PR_LIMIT=30
ISSUE_LIMIT=50
STALE_DAYS=3

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
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
  STALE_DAYS="${POSITIONAL[3]}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh"
  exit 1
fi

echo "[review-smoke] repo=${REPO}, prLimit=${PR_LIMIT}, issueLimit=${ISSUE_LIMIT}, staleDays=${STALE_DAYS}"

echo "[review-smoke] running review-open-issues"
issues_payload="$("$SCRIPT_DIR/review-open-issues.sh" --json-only "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
issues_count="$(jq -r '.count' <<<"$issues_payload")"
issues_array_len="$(jq -r '.open_issues|length' <<<"$issues_payload")"
if ! jq -e '.open_issues|type=="array"' <<<"$issues_payload" >/dev/null; then
  echo "FAIL: open-issues payload missing open_issues array"
  exit 1
fi
if (( issues_count != issues_array_len )); then
  echo "FAIL: open-issues count mismatch (${issues_count} != ${issues_array_len})"
  exit 1
fi

echo "[review-smoke] running review-open-prs"
prs_payload="$("$SCRIPT_DIR/review-open-prs.sh" --json-only "$REPO" "$PR_LIMIT")"
open_pr_count="$(jq -r '.count' <<<"$prs_payload")"
open_pr_len="$(jq -r '.open_prs|length' <<<"$prs_payload")"
if ! jq -e '.open_prs|type=="array"' <<<"$prs_payload" >/dev/null; then
  echo "FAIL: open-prs payload missing open_prs array"
  exit 1
fi
if (( open_pr_count != open_pr_len )); then
  echo "FAIL: open-prs count mismatch (${open_pr_count} != ${open_pr_len})"
  exit 1
fi

echo "[review-smoke] running review-pr-dependency"
dependency_payload="$("$SCRIPT_DIR/review-pr-dependency.sh" --json-only "$REPO")"
if [[ "$dependency_payload" != "[]" ]] && ! jq -e '.|type=="array"' <<<"$dependency_payload" >/dev/null; then
  echo "FAIL: dependency payload is not an array"
  exit 1
fi

echo "[review-smoke] running review-blocker-digest"
blocker_payload="$("$SCRIPT_DIR/review-blocker-digest.sh" --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.summary|type=="object"' <<<"$blocker_payload" >/dev/null; then
  echo "FAIL: blocker payload missing summary object"
  exit 1
fi
blocking_prs="$(jq -r '.summary.blocking_prs' <<<"$blocker_payload")"
stale_alerts="$(jq -r '.summary.stale_unassigned_issue_alerts' <<<"$blocker_payload")"
no_pr_alerts="$(jq -r '.summary.unassigned_no_open_pr_link_alerts' <<<"$blocker_payload")"
if [[ ! "$blocking_prs" =~ ^[0-9]+$ ]] || [[ ! "$stale_alerts" =~ ^[0-9]+$ ]] || [[ ! "$no_pr_alerts" =~ ^[0-9]+$ ]]; then
  echo "FAIL: blocker summary contains non-integer values"
  exit 1
fi
if ! jq -e '.blocking_prs|type=="array"' <<<"$blocker_payload" >/dev/null; then
  echo "FAIL: blocker payload missing blocking_prs array"
  exit 1
fi
if ! jq -e '.blocking_issues|type=="array"' <<<"$blocker_payload" >/dev/null; then
  echo "FAIL: blocker payload missing blocking_issues array"
  exit 1
fi

echo "[review-smoke] running review-project-status"
status_payload="$("$SCRIPT_DIR/review-project-status.sh" --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.counts.open_prs|type=="number" and .>=0' <<<"$status_payload" >/dev/null; then
  echo "FAIL: project status counts.open_prs invalid"
  exit 1
fi
if ! jq -e '.counts.open_issues|type=="number" and .>=0' <<<"$status_payload" >/dev/null; then
  echo "FAIL: project status counts.open_issues invalid"
  exit 1
fi
status_blockers="$(jq -r '.counts.blocking_total' <<<"$status_payload")"
if (( status_blockers != blocking_prs + stale_alerts + no_pr_alerts )); then
  echo "FAIL: project status blocking_total mismatch"
  exit 1
fi

echo "[review-smoke] running review-issue-candidates"
candidate_payload="$("$SCRIPT_DIR/review-issue-candidates.sh" --json "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
candidate_count="$(jq -r '.candidateCount' <<<"$candidate_payload")"
if [[ ! "$candidate_count" =~ ^[0-9]+$ ]]; then
  echo "FAIL: candidate payload malformed"
  exit 1
fi
echo "[review-smoke] issue-candidate count: ${candidate_count}"

echo "[review-smoke] running review-issue-ref-audit"
issue_ref_payload="$("$SCRIPT_DIR/review-issue-ref-audit.sh" --json-only "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.issues|type=="array"' <<<"$issue_ref_payload" >/dev/null; then
  echo "FAIL: issue-ref-audit payload missing issues array"
  exit 1
fi
if ! jq -e '.totalOpenIssues|type=="number"' <<<"$issue_ref_payload" >/dev/null; then
  echo "FAIL: issue-ref-audit totalOpenIssues missing"
  exit 1
fi
if ! jq -e '.candidateCount|type=="number"' <<<"$issue_ref_payload" >/dev/null; then
  echo "FAIL: issue-ref-audit candidateCount missing"
  exit 1
fi
if ! jq -e '.blockedCount|type=="number"' <<<"$issue_ref_payload" >/dev/null; then
  echo "FAIL: issue-ref-audit blockedCount missing"
  exit 1
fi
issue_ref_candidate_count="$(jq -r '.candidateCount' <<<"$issue_ref_payload")"
issue_ref_blocked_count="$(jq -r '.blockedCount' <<<"$issue_ref_payload")"
issue_ref_skipped_count="$(jq -r '.skippedCount // 0' <<<"$issue_ref_payload")"
issue_ref_total="$(jq -r '.totalOpenIssues' <<<"$issue_ref_payload")"
if [[ ! "$issue_ref_candidate_count" =~ ^[0-9]+$ ]] || \
   [[ ! "$issue_ref_blocked_count" =~ ^[0-9]+$ ]] || \
   [[ ! "$issue_ref_skipped_count" =~ ^[0-9]+$ ]] || \
   [[ ! "$issue_ref_total" =~ ^[0-9]+$ ]]; then
  echo "FAIL: issue-ref-audit counts are not all non-negative integers"
  exit 1
fi
if [[ "$candidate_count" != "$issue_ref_candidate_count" ]]; then
  echo "FAIL: candidate count mismatch (${candidate_count} != ${issue_ref_candidate_count})"
  exit 1
fi
if (( issue_ref_candidate_count + issue_ref_blocked_count + issue_ref_skipped_count != issue_ref_total )); then
  echo "FAIL: issue-ref partition mismatch (candidates + blocked + skipped != total)"
  exit 1
fi

echo "[review-smoke] running review-root-cause"
root_cause_payload="$("$SCRIPT_DIR/review-root-cause.sh" --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.items|type=="array"' <<<"$root_cause_payload" >/dev/null; then
  echo "FAIL: root-cause payload missing items array"
  exit 1
fi
if ! jq -e '.blockingCount|type=="number"' <<<"$root_cause_payload" >/dev/null; then
  echo "FAIL: root-cause blockingCount missing"
  exit 1
fi
if ! jq -e '.candidateCount|type=="number"' <<<"$root_cause_payload" >/dev/null; then
  echo "FAIL: root-cause candidateCount missing"
  exit 1
fi
root_total="$(jq -r '.items|length' <<<"$root_cause_payload")"
root_cause_candidate_count="$(jq -r '.candidateCount' <<<"$root_cause_payload")"
root_cause_blocking_count="$(jq -r '.blockingCount' <<<"$root_cause_payload")"
if [[ ! "$root_cause_candidate_count" =~ ^[0-9]+$ ]] || [[ ! "$root_cause_blocking_count" =~ ^[0-9]+$ ]]; then
  echo "FAIL: root-cause count fields are not non-negative integers"
  exit 1
fi
if (( candidate_count != root_cause_candidate_count )); then
  echo "FAIL: root-cause candidateCount mismatch (${candidate_count} != ${root_cause_candidate_count})"
  exit 1
fi
if (( root_total != (issue_ref_candidate_count + issue_ref_blocked_count) )); then
  echo "FAIL: root-cause items length mismatch (${root_total} != ${issue_ref_candidate_count} + ${issue_ref_blocked_count})"
  exit 1
fi
if (( root_total + issue_ref_skipped_count != issue_ref_total )); then
  echo "FAIL: root-cause/issue-ref partition mismatch (${root_total} + ${issue_ref_skipped_count} != ${issue_ref_total})"
  exit 1
fi

echo "[review-smoke] running review-blocker-priority"
priority_payload="$("$SCRIPT_DIR/review-blocker-priority.sh" --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e 'has("blockerPriority") and has("candidatePriority")' <<<"$priority_payload" >/dev/null; then
  echo "FAIL: blocker-priority payload missing expected keys"
  exit 1
fi
if ! jq -e '.blockerPriority|type=="array"' <<<"$priority_payload" >/dev/null; then
  echo "FAIL: blocker-priority blockerPriority is not an array"
  exit 1
fi
if ! jq -e '.candidatePriority|type=="array"' <<<"$priority_payload" >/dev/null; then
  echo "FAIL: blocker-priority candidatePriority is not an array"
  exit 1
fi
priority_total="$(jq -r '.totalIssues' <<<"$priority_payload")"
priority_blockers="$(jq -r '.blockingCount' <<<"$priority_payload")"
priority_candidates="$(jq -r '.candidateCount' <<<"$priority_payload")"
root_total="$(jq -r '.items|length' <<<"$root_cause_payload")"
root_blockers="$(jq -r '.blockingCount' <<<"$root_cause_payload")"
root_candidates="$(jq -r '.candidateCount' <<<"$root_cause_payload")"
if (( priority_total != root_total )); then
  echo "FAIL: blocker-priority total mismatch (${priority_total} != ${root_total})"
  exit 1
fi
if (( priority_blockers != root_blockers )); then
  echo "FAIL: blocker-priority blockerCount mismatch (${priority_blockers} != ${root_blockers})"
  exit 1
fi
if (( priority_candidates != root_candidates )); then
  echo "FAIL: blocker-priority candidateCount mismatch (${priority_candidates} != ${root_candidates})"
  exit 1
fi

echo "PASS: review-smoke"
exit 0
