#!/usr/bin/env bash
set -euo pipefail

# Identify open issues that may be ready for close/re-scope review:
# - unassigned
# - no open-PR linkage in body references
# - all referenced issues/PRs are already closed/merged
#
# Usage:
#   scripts/review-issue-candidates.sh [options] [repo] [issueLimit] [staleDays]

usage() {
  cat <<'EOF'
Usage:
  scripts/review-issue-candidates.sh [options] [repo] [issueLimit] [staleDays]

Options:
  --json        emit machine-readable JSON
  --help, -h    show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
MAX_OPEN=80
STALE_DAYS=3
OUTPUT_JSON=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
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
  MAX_OPEN="${POSITIONAL[1]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 3 ]]; then
  STALE_DAYS="${POSITIONAL[2]}"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh CLI not found"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq not found"
  exit 1
fi

issues_payload="$(scripts/review-open-issues.sh --json-only "$REPO" "$MAX_OPEN" "$STALE_DAYS")"
if ! jq -e '.open_issues|type=="array"' <<<"$issues_payload" >/dev/null; then
  echo "failed to parse issues payload"
  exit 1
fi

resolve_state() {
  local ref="$1"
  local state

  if state="$(gh pr view "$ref" --repo "$REPO" --json state 2>/dev/null | jq -r '.state // ""')"; then
    echo "pr:${state}"
    return 0
  fi

  if state="$(gh issue view "$ref" --repo "$REPO" --json state 2>/dev/null | jq -r '.state // ""')"; then
    echo "issue:${state}"
    return 0
  fi

  echo "missing"
}

if (( OUTPUT_JSON == 1 )); then
  candidate_jsonl="$(mktemp)"
  trap 'rm -f "$candidate_jsonl"' EXIT
fi

candidate_count=0
total_open=0

while IFS= read -r issue; do
  number="$(jq -r '.number' <<<"$issue")"
  title="$(jq -r '.title' <<<"$issue")"
  assignees="$(jq -r '.assignees | length' <<<"$issue")"
  linked_prs="$(jq -r '.linkedOpenPRs | length' <<<"$issue")"
  linked_prs_list="$(jq -c '.linkedOpenPRs // []' <<<"$issue")"
  refs="$(jq -r '.bodyIssueRefs | map(tostring) | join(" ")' <<<"$issue")"
  total_open=$((total_open + 1))

  if [[ "$assignees" -gt 0 || "$linked_prs" -gt 0 ]]; then
    continue
  fi

  unresolved=0
  IFS=' ' read -r -a ref_list <<< "$refs"
  for ref in "${ref_list[@]}"; do
    [[ -z "$ref" ]] && continue
    state="$(resolve_state "$ref")"
    case "$state" in
      pr:OPEN|issue:OPEN)
        unresolved=1
        break
        ;;
    esac
  done

  if (( unresolved == 0 )); then
    candidate_count=$((candidate_count + 1))
    if (( OUTPUT_JSON == 1 )); then
      jq -cn \
        --argjson number "$number" \
        --arg title "$title" \
        --argjson linkedOpenPRs "$linked_prs_list" \
        --arg refs "$refs" \
        '{number:$number, title:$title, linkedOpenPRs:$linkedOpenPRs, bodyIssueRefs:($refs|split(" ") | map(select(length>0))), reason:"all referenced items closed/merged or missing"}' \
        >> "$candidate_jsonl"
      echo >> "$candidate_jsonl"
    else
      echo "- #${number} ${title}"
      echo "  body refs: ${refs:-<none>}"
      echo "  linked open PRs: ${linked_prs}"
      echo
    fi
  fi
done < <(jq -c '.open_issues[]' <<<"$issues_payload")

if (( OUTPUT_JSON == 1 )); then
  candidates="$(cat "$candidate_jsonl" | jq -s .)"
  jq -cn --arg repo "$REPO" --argjson total "$total_open" --argjson count "$candidate_count" --argjson candidates "$candidates" '{repo:$repo, totalOpenIssues:$total, candidateCount:$count, candidates:$candidates}'
  exit 0
fi

echo "totalOpenIssues: ${total_open} | candidateCloseLikeCount: ${candidate_count}"
