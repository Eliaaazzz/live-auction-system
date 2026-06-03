#!/usr/bin/env bash
set -euo pipefail

# Produce a review blocker action order from root-cause:
# - blockers are listed first (sorted by number of open blockers)
# - candidates are listed separately.
#
# Usage:
#   scripts/review-blocker-priority.sh [options] [repo] [prLimit] [issueLimit] [staleDays]

usage() {
  cat <<'USAGE'
Usage:
  scripts/review-blocker-priority.sh [options] [repo] [prLimit] [issueLimit] [staleDays]

Options:
  --json-only  emit machine-readable JSON payload only
  --help, -h   show this help
USAGE
}

REPO="github.com/Eliaaazzz/live-auction-system"
PR_LIMIT=20
ISSUE_LIMIT=80
STALE_DAYS=3
OUTPUT_JSON=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json-only)
      OUTPUT_JSON=1
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

root_payload="$(scripts/review-root-cause.sh --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.items|type=="array"' <<<"$root_payload" >/dev/null; then
  echo "failed to parse root-cause payload"
  exit 1
fi

items_json="$(jq -c '.items' <<<"$root_payload")"
blockers_json="$(jq -c '[.[] | select((.status == "BLOCKED") or (.rootBlockers|length>0))] | sort_by(-((.openRefs // [])|length), .number)' <<<"$items_json")"
candidates_json="$(jq -c '[.[] | select(.candidate == true)] | sort_by(.number)' <<<"$items_json")"

if (( OUTPUT_JSON == 1 )); then
  jq -cn \
    --arg repo "$REPO" \
    --argjson generatedAt "$(date +%s)" \
    --argjson totalIssues "$(jq -r 'length' <<<"$items_json")" \
    --argjson blockerPriority "$blockers_json" \
    --argjson candidatePriority "$candidates_json" \
    '{repo:$repo, generatedAt:($generatedAt|tonumber), totalIssues:$totalIssues, blockingCount:($blockerPriority|length), candidateCount:($candidatePriority|length), blockerPriority:$blockerPriority, candidatePriority:$candidatePriority}'
  exit 0
fi

cat <<EOF_HEADER
# Review blocker priority (${REPO})
- generated: $(date -u +'%Y-%m-%d %H:%M:%SZ')

## Priority blockers
EOF_HEADER

if [[ "$(jq -r 'length' <<<"$blockers_json")" == "0" ]]; then
  echo "- none"
else
  jq -r '.[] as $issue | "- #" + ($issue.number|tostring) + " " + $issue.title + " openRefs=" + (if (($issue.openRefs // [])|length>0) then (($issue.openRefs | map(tostring) | join(",")) | tostring) else "<none>" end) + " rootBlockers=" + (($issue.rootBlockers // []) | join(","))' <<<"$blockers_json"
fi

cat <<EOF_HEADER

## Candidate issues
EOF_HEADER

if [[ "$(jq -r 'length' <<<"$candidates_json")" == "0" ]]; then
  echo "- none"
else
  jq -r '.[] | "- #\(.number) \(.title)"' <<<"$candidates_json"
fi
