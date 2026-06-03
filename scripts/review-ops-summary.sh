#!/usr/bin/env bash
set -euo pipefail

# Produce one-shot review operating summary for maintainer handoff.
#
# Usage:
#   scripts/review-ops-summary.sh [options] [repo] [issueLimit] [staleDays]
# Example:
#   scripts/review-ops-summary.sh github.com/Eliaaazzz/live-auction-system 80 3

usage() {
  cat <<'EOF'
Usage:
  scripts/review-ops-summary.sh [options] [repo] [issueLimit] [staleDays]

Options:
  --json        emit machine JSON summary
  --markdown    emit markdown-friendly summary (default)
  --help, -h    show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
ISSUE_LIMIT=80
STALE_DAYS=3
OUTPUT_JSON=0
OUTPUT_MD=1

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --markdown)
      OUTPUT_MD=1
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
  ISSUE_LIMIT="${POSITIONAL[1]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 3 ]]; then
  STALE_DAYS="${POSITIONAL[2]}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh"
  exit 1
fi

status_payload="$(scripts/review-project-status.sh --json-only "$REPO" 20 "$ISSUE_LIMIT" "$STALE_DAYS")"
candidate_payload="$(scripts/review-issue-candidates.sh --json "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
issue_ref_payload="$(scripts/review-issue-ref-audit.sh --json-only "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
root_cause_payload="$(scripts/review-root-cause.sh --json-only "$REPO" 20 "$ISSUE_LIMIT" "$STALE_DAYS")"
priority_payload="$(scripts/review-blocker-priority.sh --json-only "$REPO" 20 "$ISSUE_LIMIT" "$STALE_DAYS")"

counts="$(jq -c '.counts' <<<"$status_payload")"
candidate_count="$(jq -r '.candidateCount' <<<"$candidate_payload")"
candidate_items="$(jq -c '.candidates' <<<"$candidate_payload")"
candidates_short="$(jq -c '.candidates | sort_by(.number) | .[0:10]' <<<"$candidate_payload")"
issue_ref_total="$(jq -r '.totalOpenIssues' <<<"$issue_ref_payload")"
issue_ref_candidate_count="$(jq -r '.candidateCount' <<<"$issue_ref_payload")"
issue_ref_blocked_count="$(jq -r '.blockedCount' <<<"$issue_ref_payload")"
issue_ref_items="$(jq -c '.issues' <<<"$issue_ref_payload")"
issue_ref_blocked_short="$(jq -c '.issues | map(select(.status == "BLOCKED")) | sort_by(.number) | .[0:10]' <<<"$issue_ref_payload")"
issue_ref_candidate_short="$(jq -c '.issues | map(select(.status == "CANDIDATE")) | sort_by(.number) | .[0:10]' <<<"$issue_ref_payload")"
root_blocked_count="$(jq -r '.blockingCount' <<<"$root_cause_payload")"
root_candidate_count="$(jq -r '.candidateCount' <<<"$root_cause_payload")"
priority_blockers="$(jq -c '.blockerPriority | .[0:10]' <<<"$priority_payload")"
priority_total="$(jq -r '.totalIssues' <<<"$priority_payload")"
priority_blocking_count="$(jq -r '.blockingCount' <<<"$priority_payload")"
priority_candidate_count="$(jq -r '.candidateCount' <<<"$priority_payload")"
open_issue_count="$(jq -r '.counts.open_issues' <<<"$status_payload")"
open_pr_count="$(jq -r '.counts.open_prs' <<<"$status_payload")"
blocking_total="$(jq -r '.counts.blocking_total' <<<"$status_payload")"

if (( OUTPUT_JSON == 1 )); then
  jq -cn \
    --arg repo "$REPO" \
    --argjson generatedAt "$(date +%s)" \
    --argjson counts "$counts" \
    --argjson candidateCount "$candidate_count" \
    --argjson candidates "$candidate_items" \
    --argjson rootCause "$root_cause_payload" \
    --argjson issueRefAuditTotal "$issue_ref_total" \
    --argjson issueRefAuditCandidateCount "$issue_ref_candidate_count" \
    --argjson issueRefAuditBlockedCount "$issue_ref_blocked_count" \
    --argjson issueRefAuditItems "$issue_ref_items" \
    --argjson priority "$priority_payload" \
    '{repo:$repo, generatedAt:$generatedAt, counts:$counts, candidateCount:$candidateCount, candidates:$candidates, issueRefAudit:{totalOpenIssues:$issueRefAuditTotal, candidateCount:$issueRefAuditCandidateCount, blockedCount:$issueRefAuditBlockedCount, issues:$issueRefAuditItems}, rootCause:$rootCause, blockerPriority:$priority}'
  exit 0
fi

if (( OUTPUT_MD == 1 )); then
  echo "# Review ops summary (${REPO})"
  echo "- generated: $(date -u +'%Y-%m-%d %H:%M:%SZ')"
  echo "## Snapshot"
  echo "- open PRs: ${open_pr_count}"
  echo "- open issues: ${open_issue_count}"
  echo "- blocking items: ${blocking_total}"
  echo "- priority issues total: ${priority_total} (blockers=${priority_blocking_count}, candidates=${priority_candidate_count})"
  echo
  echo "## Candidate issues (unassigned + no open PR link + references closed)"
  if [[ "$candidate_count" == "0" ]]; then
    echo "- none"
  else
    jq -r '.[] | "- #\(.number) \(.title) refs: " + (if ((.bodyIssueRefs // [])|length>0) then ((.bodyIssueRefs // [])|join(", ")) else "<none>" end)' <<<"$candidates_short"
  fi
  echo
  echo "## Raw blocker details"
  echo "- no-open-pr-link alerts: $(jq -r '.counts.unassigned_no_open_pr_link_alerts' <<<"$status_payload")"
  echo "- stale unassigned alerts: $(jq -r '.counts.stale_unassigned_issue_alerts' <<<"$status_payload")"
  echo "- blocking PRs: $(jq -r '.counts.blocking_prs' <<<"$status_payload")"
  echo
  echo "## Reference audit"
  echo "- unassigned issues with no open PR links: ${issue_ref_total} | candidates: ${issue_ref_candidate_count} | blocked: ${issue_ref_blocked_count}"
  echo
  if (( issue_ref_candidate_count > 0 )); then
    echo "### Candidate issues (all references closed/missing)"
    jq -r '.[] | "- #\(.number) \(.title) closed/missing refs: " + (if (.closedRefs|length>0) then (.closedRefs|join(", ")) else "<none>" end)' <<<"$issue_ref_candidate_short"
    echo
  fi
  if (( issue_ref_blocked_count > 0 )); then
    echo "### Blocked issues (still-open refs)"
    jq -r '.[] | "- #\(.number) \(.title) open refs: " + ((.openRefs // []) | join(", ")) + " | closed/missing: " + (if ((.closedRefs // [])|length>0) then ((.closedRefs // [])|join(", ")) else "<none>" end)' <<<"$issue_ref_blocked_short"
    echo
  fi

  echo "## Root-cause convergence"
  echo "- consolidated blockers: ${root_blocked_count}"
  echo "- consolidated candidates: ${root_candidate_count}"
  if [[ "$root_blocked_count" != "0" ]]; then
    echo "### Blocker IDs (blocked or with root blockers)"
    jq -r '.items[] | "- #\(.number) \(.title) | " + (if (.status=="BLOCKED") then "ref-blocked" else "" end) + (if ((.rootBlockers // [])|length>0) then " " + (((.rootBlockers // [])|join(","))) else "" end)' <<<"$root_cause_payload"
    echo
  fi
  if [[ "$priority_blocking_count" != "0" ]]; then
    echo "### Priority action order"
    jq -r '.[] | if (((.openRefs // []) | length) > 0) then
      "- #\(.number) \(.title) [openRefs=\(.openRefs // [] | map(tostring) | join(","))] blockers=\((.rootBlockers // []) | join(","))"
    else
      "- #\(.number) \(.title) [openRefs=none] blockers=\((.rootBlockers // []) | join(","))"
    end' <<<"$priority_blockers"
    echo
  fi
  if [[ "$root_candidate_count" != "0" ]]; then
    echo "### Candidate IDs"
    jq -r '.items[] | select(.candidate==true) | "- #\(.number) \(.title)"' <<<"$root_cause_payload"
  fi
  exit 0
fi
