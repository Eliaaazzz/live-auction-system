#!/usr/bin/env bash
set -euo pipefail

# Open-issue health audit for review lanes:
# - lists open issues with labels + assignees + update age
# - surfaces possible PR linkage hints embedded in body
# - flags stale items by age
#
# Usage:
#   scripts/review-open-issues.sh [options] [repo] [max] [stale_days]
# Example:
#   scripts/review-open-issues.sh github.com/Eliaaazzz/live-auction-system 30 2
#   scripts/review-open-issues.sh --json github.com/Eliaaazzz/live-auction-system 30 2

usage() {
  cat <<'USAGE'
Usage:
  scripts/review-open-issues.sh [options] [repo] [max] [stale_days]

Options:
  --json        emit machine-readable JSON payload at the end
  --json-only   emit only machine JSON (implies --json), no human-readable logs
  --help, -h    show this help
USAGE
}

REPO="github.com/Eliaaazzz/live-auction-system"
MAX_OPEN=50
STALE_DAYS=3
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
if [[ "${#POSITIONAL[@]}" -ge 3 ]]; then
  STALE_DAYS="${POSITIONAL[2]}"
fi

if [[ "$OUTPUT_JSON" == "1" ]]; then
  ISSUE_JSONL="$(mktemp)"
  trap 'rm -f "$ISSUE_JSONL"' EXIT
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

if ! command -v date >/dev/null 2>&1; then
  echo "required: date not found"
  exit 1
fi

now_ts="$(date -u +%s)"
stale_label=$((STALE_DAYS + 0))

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

echo "=== Open issue audit ($REPO) ==="

issues_json="$(gh issue list --repo "$REPO" --state open --limit "$MAX_OPEN" --json number,title,body,author,createdAt,updatedAt,comments,labels,assignees,url)"
open_pr_refs="$(gh pr list --repo "$REPO" --state open --json number,body)"
echo "count: $(jq 'length' <<<"$issues_json")"
echo

if [[ "$(jq 'length' <<<"$issues_json")" -eq 0 ]]; then
  if [[ "$OUTPUT_JSON" == "1" ]]; then
    jq -nc --arg repo "$REPO" --argjson count "$(jq 'length' <<<"$issues_json")" '{repo:$repo, count:$count, open_issues:[]}' >&$json_output_fd
    exit 0
  fi
  echo "No open issues."
  exit 0
fi

jq -c '.[]' <<<"$issues_json" | while read -r issue; do
  num="$(jq -r '.number' <<<"$issue")"
  title="$(jq -r '.title' <<<"$issue")"
  author="$(jq -r '.author.login' <<<"$issue")"
  created="$(jq -r '.createdAt // .updatedAt' <<<"$issue")"
  updated="$(jq -r '.updatedAt // .createdAt' <<<"$issue")"
  comment_count="$(jq -r 'if .comments then (.comments | length) else 0 end' <<<"$issue")"
  url="$(jq -r '.url' <<<"$issue")"

  labels="$(jq -r '[.labels[].name] | join(", ")' <<<"$issue")"
  assignees="$(jq -r '[.assignees[].login] | join(", ")' <<<"$issue")"
  if [[ -z "$assignees" ]]; then
    assignees="<unassigned>"
  fi
  if [[ -z "$labels" ]]; then
    labels="<none>"
  fi

  body="$(jq -r '.body // ""' <<<"$issue")"
  body_refs_raw="$(printf '%s\n' "$body" | grep -Eo '#[0-9]+' | xargs -n1 | sort -u || true)"
  if [[ -n "$body_refs_raw" ]]; then
    body_refs_display="$(printf '%s' "$body_refs_raw" | tr '\n' ' ' | sed 's/[[:space:]]*$//' | sed 's/#/issue-/g')"
  else
    body_refs_display="<none>"
  fi

  linked_pr_numbers="$(jq --argjson n "$num" '[.[] | select((.body // "") | contains("#" + ($n | tostring))) | .number]' <<<"$open_pr_refs")"
  linked_pr_display="$(jq -r 'map("#" + (. | tostring)) | join(" ")' <<<"$linked_pr_numbers")"

  parsed_ts="$(parse_ts "$updated")"
  if [[ -z "$parsed_ts" ]]; then
    parsed_ts="$(parse_ts "$created")"
  fi

  age_days="0"
  stale_note=""
  if [[ -n "$parsed_ts" ]]; then
    age_days=$(( (now_ts - parsed_ts) / 86400 ))
    if (( age_days > stale_label )); then
      stale_note=" (stale > ${STALE_DAYS}d)"
    fi
  else
    stale_note=" (unknown age)"
  fi

  age_display="${age_days}d"

  echo "## #${num} ${title}"
  echo "author: ${author} | assignees: ${assignees}"
  echo "labels: ${labels}"
  echo "created: ${created} | updated: ${updated} | age: ${age_display}${stale_note}"
  echo "comments: ${comment_count} | possible refs: ${body_refs_display} | linked open PRs: ${linked_pr_display:-<none>}"
  echo "url: ${url}"
  echo

  if [[ "$OUTPUT_JSON" == "1" ]]; then
    body_refs_json="$(printf '%s\n' "$body_refs_raw" | sed 's/^#//g' | sed '/^[[:space:]]*$/d' | jq -R . | jq -s .)"
    assignees_json="$(printf '%s' "$assignees" | sed 's/^<unassigned>$//g' | tr ', ' '\n' | sed '/^[[:space:]]*$/d' | jq -R . | jq -s .)"
    labels_json="$(printf '%s' "$labels" | sed 's/^<none>$//g' | tr ', ' '\n' | sed '/^[[:space:]]*$/d' | jq -R . | jq -s .)"
    linked_prs_json="$(printf '%s\n' "${linked_pr_display:-}" | tr ' ' '\n' | sed 's/^#//' | sed '/^[[:space:]]*$/d' | jq -R . | jq -s .)"
    jq -cn \
      --argjson number "$num" \
      --arg title "$title" \
      --arg author "$author" \
      --arg created "$created" \
      --arg updated "$updated" \
      --argjson age "$age_days" \
      --argjson staleDays "$stale_label" \
      --arg comments "$comment_count" \
      --arg url "$url" \
      --argjson assignees "$assignees_json" \
      --argjson labels "$labels_json" \
      --argjson bodyRefs "$body_refs_json" \
      --argjson openPRs "$linked_prs_json" \
      '{
        number: $number,
        title: $title,
        author: $author,
        createdAt: $created,
        updatedAt: $updated,
        ageDays: ($age|tonumber),
        staleLimitDays: ($staleDays|tonumber),
        stale: ($age > $staleDays),
        commentCount: ($comments|tonumber),
        assignees: $assignees,
        labels: $labels,
        bodyIssueRefs: $bodyRefs,
        linkedOpenPRs: $openPRs,
        url: $url
      }' \
      >> "$ISSUE_JSONL"
  fi
done

if [[ "$OUTPUT_JSON" == "1" ]]; then
  open_issues="$(cat "${ISSUE_JSONL:-/dev/null}" | jq -s .)"
  jq -nc --arg repo "$REPO" --argjson count "$(jq 'length' <<<"$issues_json")" --argjson issues "$open_issues" '{repo:$repo, count:$count, open_issues:$issues}' >&$json_output_fd
fi
