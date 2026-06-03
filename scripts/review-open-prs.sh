#!/usr/bin/env bash
set -euo pipefail

# Quick review utility for Codex/maintainers:
# - lists open PRs
# - prints basic review metadata
# - highlights non-success checks
# - summarizes changed files for quick triage
#
# Usage:
#   scripts/review-open-prs.sh [options] [repo] [max]
# Example:
#   scripts/review-open-prs.sh github.com/Eliaaazzz/live-auction-system 20
#   scripts/review-open-prs.sh --json github.com/Eliaaazzz/live-auction-system 20

usage() {
  cat <<'EOF'
Usage:
  scripts/review-open-prs.sh [options] [repo] [max]

Options:
  --json        emit machine-readable JSON payload at the end
  --json-only   emit only machine JSON (implies --json), no human-readable logs
  --help, -h    show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
MAX_OPEN=30
OUTPUT_JSON=0
JSON_ONLY=0

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
  MAX_OPEN="${POSITIONAL[1]}"
fi

if [[ "$OUTPUT_JSON" == "1" ]]; then
  PR_JSONL="$(mktemp)"
  trap 'rm -f "$PR_JSONL"' EXIT
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh CLI not found"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq not found"
  exit 1
fi

json_output_fd=1
if (( OUTPUT_JSON == 1 && JSON_ONLY == 1 )); then
  exec 7>&1
  exec > /dev/null
  json_output_fd=7
fi

echo "=== Open PR audit ($REPO) ==="
echo

prs_json="$(gh pr list --repo "$REPO" --state open --limit "$MAX_OPEN" --json number,title,author,updatedAt,reviewDecision,mergeStateStatus,headRefName,baseRefName,url,reviewRequests)"
echo "count: $(jq 'length' <<<"$prs_json")"
echo

if [[ "$(jq 'length' <<<"$prs_json")" -eq 0 ]]; then
  if [[ "$OUTPUT_JSON" == "1" ]]; then
    jq -nc --arg repo "$REPO" --argjson count "$(jq 'length' <<<"$prs_json")" '{repo:$repo, count:$count, open_prs:[]}' >&$json_output_fd
    exit 0
  fi
  echo "No open PRs."
  exit 0
fi

jq -c '.[]' <<<"$prs_json" | while read -r pr; do
  num="$(jq -r '.number' <<<"$pr")"
  title="$(jq -r '.title' <<<"$pr")"
  author="$(jq -r '.author.login' <<<"$pr")"
  updated="$(jq -r '.updatedAt' <<<"$pr")"
  decision="$(jq -r '.reviewDecision // ""' <<<"$pr")"
  merge_state="$(jq -r '.mergeStateStatus' <<<"$pr")"
  head="$(jq -r '.headRefName' <<<"$pr")"
  base="$(jq -r '.baseRefName' <<<"$pr")"
  url="$(jq -r '.url' <<<"$pr")"
  review_requests="$(jq -r '[.reviewRequests[]? | (.requestedReviewer // .) | .login // .name // .title // "" ] | map(select(length > 0)) | join(", ")' <<<"$pr")"
  if [[ -z "$review_requests" ]]; then
    review_requests="<none>"
  fi

  echo "## #${num} ${title}"
  echo "author: ${author} | reviewDecision: ${decision:-N/A} | mergeState: ${merge_state}"
  echo "requestedReviewers: ${review_requests}"
  echo "branch: ${head} -> ${base}"
  echo "updatedAt: ${updated}"
  echo "url: ${url}"

  changed_json="$(gh pr view "$num" --repo "$REPO" --json files --jq '.files')"
  changed_count="$(jq 'length' <<<"$changed_json")"
  if [[ "$changed_count" -eq 0 ]]; then
    echo "changed files: <none>"
  else
    paths="$(jq -r '.[].path' <<<"$changed_json" | head -n 8 | tr '\n' ' ')"
    if [[ "$changed_count" -gt 8 ]]; then
      echo "changed files (${changed_count}): ${paths}...(+$((changed_count - 8)) more)"
    else
      echo "changed files (${changed_count}): ${paths}"
    fi
  fi

  check_json="$(gh pr checks "$num" --repo "$REPO" --json name,state,workflow,link 2>/dev/null || true)"
  failed_checks=""
  pending_checks=""
  checks_summary=""
  failed=""
  pending=""
  if [[ "$(jq 'length' <<<"${check_json:-[]}")" -eq 0 ]]; then
    echo "checks: <none>"
  else
    failed="$(jq -r '.[] | select((.state|ascii_downcase) == "failure" or (.state|ascii_downcase) == "timed_out" or (.state|ascii_downcase) == "cancelled") | "\(.name) [\(.workflow)] \(.link)"' <<<"$check_json")"
    if [[ -n "$failed" ]]; then
      echo "checks failed:"
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        echo "  - $line"
      done <<<"$failed"
    fi
    pending="$(jq -r '.[] | select((.state|ascii_downcase) == "in_progress" or (.state|ascii_downcase) == "queued" or (.state|ascii_downcase) == "queued_awaiting" or (.state|ascii_downcase) == "pending") | "\(.name) [\(.workflow)] -> \(.state)"' <<<"$check_json")"
    if [[ -n "$pending" ]]; then
      echo "checks pending:"
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        echo "  - $line"
      done <<<"$pending"
    fi
    if [[ -z "$failed" ]] && [[ -z "$pending" ]]; then
      success_count="$(jq -r '.[] | select((.state|ascii_downcase) == "success" or (.state|ascii_downcase) == "completed") | .name' <<<"$check_json" | wc -l | tr -d ' ')"
      echo "checks: $success_count passed/checked"
    else
      passing_count="$(jq -r '.[] | select((.state|ascii_downcase) == "success" or (.state|ascii_downcase) == "completed") | .name' <<<"$check_json" | wc -l | tr -d ' ')"
      total_count="$(jq 'length' <<<"$check_json")"
      if [[ -n "$passing_count" ]]; then
        echo "checks: ${passing_count}/${total_count} passed/checked"
      fi
    fi
  fi

  if [[ "$OUTPUT_JSON" == "1" ]]; then
    failed_checks="$(printf '%s\n' "$failed" | sed '/^[[:space:]]*$/d' | jq -R . | jq -s .)"
    pending_checks="$(printf '%s\n' "$pending" | sed '/^[[:space:]]*$/d' | jq -R . | jq -s .)"
    changed_files="$(jq -c 'map(.path)' <<<"$changed_json")"
    jq -cn \
      --argjson number "$num" \
      --arg title "$title" \
      --arg author "$author" \
      --arg updatedAt "$updated" \
      --arg decision "$decision" \
      --arg mergeState "$merge_state" \
      --arg reviewRequests "$review_requests" \
      --arg headRef "$head" \
      --arg baseRef "$base" \
      --arg url "$url" \
      --argjson changedCount "$changed_count" \
      --argjson changedFiles "$changed_files" \
      --argjson failedChecks "$failed_checks" \
      --argjson pendingChecks "$pending_checks" \
      '{
        number: $number,
        title: $title,
        author: $author,
        updatedAt: $updatedAt,
        reviewDecision: $decision,
        mergeState: $mergeState,
        requestedReviewers: $reviewRequests,
        branch: {head: $headRef, base: $baseRef},
        changedFileCount: $changedCount,
        changedFiles: $changedFiles,
        url: $url,
        checks: {
          failed: $failedChecks,
          pending: $pendingChecks
        }
      }' \
      >> "$PR_JSONL"
  fi
  echo
done

if [[ "$OUTPUT_JSON" == "1" ]]; then
  open_prs="$(cat "${PR_JSONL:-/dev/null}" | jq -s .)"
  jq -nc --arg repo "$REPO" --argjson count "$(jq 'length' <<<"$prs_json")" --argjson prList "$open_prs" '{repo:$repo, count:$count, open_prs:$prList}' >&$json_output_fd
fi
