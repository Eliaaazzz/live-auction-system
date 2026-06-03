#!/usr/bin/env bash
set -euo pipefail

# Reviewer blocker digest:
# - PRs that are not merge-clean (mergeState != CLEAN) or have check failures
# - Issues with no assignee + stale + no open-PR linkage in body
#
# Usage:
#   scripts/review-blocker-digest.sh [options] [repo] [prLimit] [issueLimit] [issueStaleDays]
# Example:
#   scripts/review-blocker-digest.sh github.com/Eliaaazzz/live-auction-system 30 50 2

usage() {
  cat <<'EOF'
Usage:
  scripts/review-blocker-digest.sh [options] [repo] [prLimit] [issueLimit] [issueStaleDays]

Options:
  --markdown    print markdown-friendly summary output
  --json        print machine-readable JSON payload at the end
  --json-only   print only machine JSON (implies --json), no human-readable logs
  --strict      exit with code 2 when any blocking item exists
  --help, -h    show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
PR_LIMIT=30
ISSUE_LIMIT=50
STALE_DAYS=3
OUTPUT_MARKDOWN=0
STRICT_MODE=0
OUTPUT_JSON=0
JSON_ONLY=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --markdown|--md)
      OUTPUT_MARKDOWN=1
      shift
      ;;
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
      echo "Unknown flag: $1"
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
  STALE_DAYS="${POSITIONAL[3]}"
fi

if [[ "$OUTPUT_JSON" == "1" ]]; then
  BLOCK_PR_JSONL="$(mktemp)"
  BLOCK_ISS_JSONL="$(mktemp)"
  cleanup_jsonl() {
    rm -f "$BLOCK_PR_JSONL" "$BLOCK_ISS_JSONL"
  }
  trap cleanup_jsonl EXIT
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh CLI not found"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq not found"
  exit 1
fi

if ! command -v date >/dev/null 2>&1; then
  echo "required: date not found"
  exit 1
fi

json_output_fd=1
if (( OUTPUT_JSON == 1 && JSON_ONLY == 1 )); then
  exec 7>&1
  exec > /dev/null
  json_output_fd=7
fi

parse_ts() {
  local s="$1"
  local t
  if t="$(date -u -d "$s" +%s 2>/dev/null)"; then
    echo "$t"
    return 0
  fi
  if t="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$s" +%s 2>/dev/null)"; then
    echo "$t"
    return 0
  fi
  echo ""
}

if (( OUTPUT_MARKDOWN == 1 )); then
  echo "# Review blocker digest (${REPO})"
  echo
  echo "- generated: $(date -u +'%Y-%m-%d %H:%M:%SZ')"
else
  echo "=== Review blocker digest ($REPO) ==="
fi
echo

prs_json="$(gh pr list --repo "$REPO" --state open --limit "$PR_LIMIT" --json number,title,author,updatedAt,reviewDecision,mergeStateStatus,url,body)"
open_pr_refs="$(gh pr list --repo "$REPO" --state open --json number,body)"
pr_count="$(jq 'length' <<<"$prs_json")"
if (( OUTPUT_MARKDOWN == 1 )); then
  echo "## Open PRs"
  echo "- count: ${pr_count}"
else
  echo "open PRs: $pr_count"
fi
echo

blocked_pr_count=0
if [[ "$pr_count" -gt 0 ]]; then
  if (( OUTPUT_MARKDOWN == 1 )); then
    echo "## Blocking PRs"
  else
    echo "## Blocking PRs"
  fi
  while read -r pr; do
    num="$(jq -r '.number' <<<"$pr")"
    title="$(jq -r '.title' <<<"$pr")"
    author="$(jq -r '.author.login' <<<"$pr")"
    updated="$(jq -r '.updatedAt' <<<"$pr")"
    decision="$(jq -r '.reviewDecision // ""' <<<"$pr")"
    merge_state="$(jq -r '.mergeStateStatus' <<<"$pr")"
    url="$(jq -r '.url' <<<"$pr")"
    review_notes=()

    if [[ "$merge_state" != "CLEAN" ]]; then
      review_notes+=("merge_state=$merge_state")
    fi

    if [[ "$decision" == "CHANGES_REQUESTED" ]]; then
      review_notes+=("changes_requested")
    fi

    check_json="$(gh pr checks "$num" --repo "$REPO" --json name,state,workflow,link 2>/dev/null || true)"
    if [[ -n "${check_json}" ]] && [[ "$(jq 'length' <<<"${check_json}")" -gt 0 ]]; then
      failed="$(jq -r '.[] | select((.state|ascii_downcase) == "failure" or (.state|ascii_downcase) == "timed_out" or (.state|ascii_downcase) == "cancelled") | "\(.name) [\(.workflow)]"' <<<"$check_json" | tr '\n' '; ' | sed 's/[[:space:]]*;$//' || true)"
      pending="$(jq -r '.[] | select((.state|ascii_downcase) == "in_progress" or (.state|ascii_downcase) == "queued" or (.state|ascii_downcase) == "queued_awaiting" or (.state|ascii_downcase) == "pending") | "\(.name) [\(.workflow)]"' <<<"$check_json" | tr '\n' '; ' | sed 's/[[:space:]]*;$//' || true)"
      passed_count="$(jq -r '.[] | select((.state|ascii_downcase) == "success" or (.state|ascii_downcase) == "completed") | .name' <<<"$check_json" | wc -l | tr -d ' ')"
      total_count="$(jq 'length' <<<"$check_json")"
      if [[ -n "$failed" ]]; then
        review_notes+=("checks_fail=[$failed]")
      elif [[ -n "$pending" ]]; then
        review_notes+=("checks_pending=[$pending]")
      elif [[ -n "$passed_count" && "$passed_count" != "0" ]]; then
        if [[ "$passed_count" -lt "$total_count" ]]; then
          review_notes+=("checks=${passed_count}/${total_count} ok")
        fi
      fi
    fi

    if [[ "${#review_notes[@]}" -gt 0 ]]; then
      blocked_pr_count=$((blocked_pr_count + 1))
      if [[ "$OUTPUT_JSON" == "1" ]]; then
        reasons_json="$(printf '%s\n' "${review_notes[@]}" | jq -R . | jq -s .)"
        jq -cn \
          --argjson num "$num" \
          --arg title "$title" \
          --arg owner "$author" \
          --arg updatedAt "$updated" \
          --arg mergeState "$merge_state" \
          --arg decision "$decision" \
          --arg url "$url" \
          --argjson reasons "$reasons_json" \
          '{type:"pr", number:$num, title:$title, owner:$owner, updatedAt:$updatedAt, mergeState:$mergeState, reviewDecision:$decision, url:$url, blockers:$reasons}' \
          >> "$BLOCK_PR_JSONL"
      fi
      if (( OUTPUT_MARKDOWN == 1 )); then
        echo "- PR #${num} ${title}"
        echo "  - owner: ${author} | updatedAt: ${updated}"
        echo "  - blockers: ${review_notes[*]}"
        echo "  - url: ${url}"
      else
        echo "PR #${num} ${title}"
        echo "  owner: ${author} | updatedAt: ${updated} | url: ${url}"
        echo "  blockers: ${review_notes[*]}"
      fi
      echo
    fi
  done < <(jq -c '.[]' <<<"$prs_json")
fi

if (( blocked_pr_count == 0 )); then
  if (( OUTPUT_MARKDOWN == 1 )); then
    echo "- none"
  else
    echo "No blocking PRs identified."
  fi
  echo
fi

issues_json="$(gh issue list --repo "$REPO" --state open --limit "$ISSUE_LIMIT" --json number,title,body,updatedAt,createdAt,assignees,labels,url)"
issue_count="$(jq 'length' <<<"$issues_json")"
if (( OUTPUT_MARKDOWN == 1 )); then
  echo "## Open issues"
  echo "- count: ${issue_count}"
else
  echo "open issues: $issue_count"
fi
echo

unassigned_stale_count=0
no_pr_link_count=0

if [[ "$issue_count" -gt 0 ]]; then
  now_ts="$(date -u +%s)"
  stale_label=$((STALE_DAYS + 0))

  if (( OUTPUT_MARKDOWN == 1 )); then
    echo "## Blocking Issues"
    echo "- scope: unassigned + stale > ${STALE_DAYS}d or no open-PR link"
  else
    echo "## Blocking Issues (unassigned + stale > ${STALE_DAYS}d or no open-PR link)"
  fi

  while read -r issue; do
    num="$(jq -r '.number' <<<"$issue")"
    title="$(jq -r '.title' <<<"$issue")"
    assignees="$(jq -r '[.assignees[].login] | join(",")' <<<"$issue")"
    updated="$(jq -r '.updatedAt // .createdAt' <<<"$issue")"
    created="$(jq -r '.createdAt // .updatedAt' <<<"$issue")"
    labels="$(jq -r '[.labels[].name] | join(",")' <<<"$issue")"
    url="$(jq -r '.url' <<<"$issue")"
    body="$(jq -r '.body // ""' <<<"$issue")"

    if [[ -z "$assignees" ]]; then
      assignees="<unassigned>"
    fi

    if [[ -z "$labels" ]]; then
      labels="<none>"
    fi

    linked_pr_array="$(jq --argjson n "$num" '[.[] | select((.body // "") | contains("#" + ($n|tostring))) | ("#" + (.number|tostring))]' <<<"$open_pr_refs")"
    linked_pr="$(jq -r 'join(" ")' <<<"$linked_pr_array")"

    age_ts="$(parse_ts "$updated")"
    if [[ -z "$age_ts" ]]; then
      age_ts="$(parse_ts "$created")"
    fi
    age_days=99999
    if [[ -n "$age_ts" ]]; then
      age_days=$(( (now_ts - age_ts) / 86400 ))
    fi

    reasons=()
    if [[ "$assignees" == "<unassigned>" && "$age_days" -gt "$stale_label" ]]; then
      reasons+=("stale(${age_days}d)")
      unassigned_stale_count=$((unassigned_stale_count + 1))
    fi
    if [[ -z "$linked_pr" && "$assignees" == "<unassigned>" ]]; then
      reasons+=("no-open-pr-link")
      no_pr_link_count=$((no_pr_link_count + 1))
    fi

    if [[ "${#reasons[@]}" -gt 0 ]]; then
      if [[ "$OUTPUT_JSON" == "1" ]]; then
        reasons_json="$(printf '%s\n' "${reasons[@]}" | jq -R . | jq -s .)"
        jq -cn \
          --argjson num "$num" \
          --arg title "$title" \
          --arg assignees "$assignees" \
          --arg labels "$labels" \
          --arg updatedAt "$updated" \
          --arg age "$age_days" \
          --arg url "$url" \
          --argjson openPrs "$linked_pr_array" \
          --argjson reasons "$reasons_json" \
          '{type:"issue", number:$num, title:$title, assignees:$assignees, labels:$labels, updatedAt:$updatedAt, ageDays:($age|tonumber), url:$url, openPRs:$openPrs, blockers:$reasons}' \
          >> "$BLOCK_ISS_JSONL"
      fi
      if (( OUTPUT_MARKDOWN == 1 )); then
        echo "- ISSUE #${num} ${title}"
        echo "  - assignees: ${assignees} | labels: ${labels}"
        echo "  - updated: ${updated} | age: ${age_days}d"
        echo "  - blockers: ${reasons[*]} | linked_open_prs: ${linked_pr:-<none>}"
        echo "  - url: ${url}"
      else
        echo "ISSUE #${num} ${title}"
        echo "  assignees: ${assignees} | labels: ${labels}"
        echo "  updated: ${updated} | age: ${age_days}d"
        echo "  url: ${url}"
        echo "  blockers: ${reasons[*]} | linked_open_prs: ${linked_pr:-<none>}"
      fi
      echo
    fi
  done < <(jq -c '.[]' <<<"$issues_json")
fi

if (( unassigned_stale_count == 0 && no_pr_link_count == 0 )); then
  if (( OUTPUT_MARKDOWN == 1 )); then
    echo "- none"
  else
    echo "No blocking issues identified."
  fi
  echo
fi

if (( OUTPUT_MARKDOWN == 1 )); then
  echo "## Summary"
  echo "- blocking_prs: ${blocked_pr_count}"
  echo "- stale_unassigned_issue_alerts: ${unassigned_stale_count}"
  echo "- unassigned_no_open_pr_link_alerts: ${no_pr_link_count}"
else
  echo "summary"
  echo "  blocking_prs: ${blocked_pr_count}"
  echo "  stale_unassigned_issue_alerts: ${unassigned_stale_count}"
  echo "  unassigned_no_open_pr_link_alerts: ${no_pr_link_count}"
fi

if (( OUTPUT_JSON == 1 )); then
  blocked_prs="$(cat "${BLOCK_PR_JSONL:-/dev/null}" | jq -s .)"
  blocking_issues="$(cat "${BLOCK_ISS_JSONL:-/dev/null}" | jq -s .)"
  jq -nc \
    --arg repo "$REPO" \
    --argjson blockingPrs "$blocked_pr_count" \
    --argjson staleIssues "$unassigned_stale_count" \
    --argjson openPrLinkIssues "$no_pr_link_count" \
    --argjson blockerPrList "$blocked_prs" \
    --argjson blockerIssueList "$blocking_issues" \
    '{
      repo: $repo,
      summary: {
        blocking_prs: $blockingPrs,
        stale_unassigned_issue_alerts: $staleIssues,
        unassigned_no_open_pr_link_alerts: $openPrLinkIssues
      },
      blocking_prs: $blockerPrList,
      blocking_issues: $blockerIssueList
    }' >&$json_output_fd
fi

if (( STRICT_MODE == 1 )); then
  total_blockers=$((blocked_pr_count + unassigned_stale_count + no_pr_link_count))
  if (( total_blockers > 0 )); then
    echo
    echo "blocking items detected: ${total_blockers}"
    exit 2
  fi
fi
