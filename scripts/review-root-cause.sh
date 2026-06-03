#!/usr/bin/env bash
set -euo pipefail

# Produce a single, reviewable root-cause snapshot:
# - issues blocked by open references
# - issues blocked by missing/absent open-PR linkage
# - candidate issues (unassigned + no open PR links + closed refs)
#
# Usage:
#   scripts/review-root-cause.sh [options] [repo] [prLimit] [issueLimit] [staleDays]

usage() {
  cat <<'USAGE'
Usage:
  scripts/review-root-cause.sh [options] [repo] [prLimit] [issueLimit] [staleDays]

Options:
  --json        emit machine-readable JSON payload
  --json-only   emit only machine-readable JSON payload
  --help, -h    show this help
USAGE
}

REPO="github.com/Eliaaazzz/live-auction-system"
PR_LIMIT=20
ISSUE_LIMIT=80
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

if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh CLI not found"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq not found"
  exit 1
fi

issue_ref_payload="$(scripts/review-issue-ref-audit.sh --json-only "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.issues|type=="array"' <<<"$issue_ref_payload" >/dev/null; then
  echo "failed to parse issue-ref-audit payload"
  exit 1
fi

blocker_payload="$(scripts/review-blocker-digest.sh --json-only "$REPO" "$PR_LIMIT" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.summary|type=="object"' <<<"$blocker_payload" >/dev/null; then
  echo "failed to parse blocker payload"
  exit 1
fi

candidate_payload="$(scripts/review-issue-candidates.sh --json "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.candidates|type=="array"' <<<"$candidate_payload" >/dev/null; then
  echo "failed to parse candidate payload"
  exit 1
fi

candidates="$(jq -c '.candidates' <<<"$candidate_payload")"

# Build quick lookups for open-PR-link blockers and stale blockers.
no_open_pr_link_issues="$(jq -c '[.blocking_issues[] | select(.blockers[] | tostring | contains("no-open-pr-link")) | .number]' <<<"$blocker_payload")"
stale_unassigned_issues="$(jq -c '[.blocking_issues[] | select(.blockers[] | tostring | contains("stale(")) | .number]' <<<"$blocker_payload")"

open_issue_payload="$(scripts/review-open-issues.sh --json-only "$REPO" "$ISSUE_LIMIT" "$STALE_DAYS")"
if ! jq -e '.open_issues|type=="array"' <<<"$open_issue_payload" >/dev/null; then
  echo "failed to parse open-issues payload"
  exit 1
fi

# Resolve referenced open items to title/type/url for actionable root-cause output.
resolve_ref() {
  local ref="$1"
  local payload=""
  local kind=""
  local state=""
  local title=""
  local url=""
  local cached

  cached="$(awk -F'\t' -v ref="$ref" '$1 == ref { print $0; exit }' "$ref_cache" || true)"
  if [[ -n "$cached" ]]; then
    kind="$(awk -F'\t' '{print $3}' <<<"$cached")"
    state="$(awk -F'\t' '{print $2}' <<<"$cached")"
    title="$(awk -F'\t' '{print $4}' <<<"$cached")"
    url="$(awk -F'\t' '{print $5}' <<<"$cached")"
    local json
    json="$(jq -cn --arg num "$ref" --arg kind "$kind" --arg state "$state" --arg title "$title" --arg url "$url" '{number: ($num|tonumber), kind:$kind, state:$state, title:$title, url:$url}')"
    printf '%s\n' "$json"
    return
  fi

  if payload="$(gh pr view "$ref" --repo "$REPO" --json number,title,state,updatedAt,url 2>/dev/null)"; then
    kind="pr"
    state="$(jq -r '.state // ""' <<<"$payload")"
    title="$(jq -r '.title // ""' <<<"$payload")"
    url="$(jq -r '.url // ""' <<<"$payload")"
  elif payload="$(gh issue view "$ref" --repo "$REPO" --json number,title,state,updatedAt,url 2>/dev/null)"; then
    kind="issue"
    state="$(jq -r '.state // ""' <<<"$payload")"
    title="$(jq -r '.title // ""' <<<"$payload")"
    url="$(jq -r '.url // ""' <<<"$payload")"
  else
    kind="missing"
    state="MISSING"
    title=""
    url=""
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$ref" "$state" "$kind" "$title" "$url" >> "$ref_cache"

  local json
  json="$(jq -cn --arg num "$ref" --arg kind "$kind" --arg state "$state" --arg title "$title" --arg url "$url" '{number: ($num|tonumber), kind:$kind, state:$state, title:$title, url:$url}')"
  printf '%s\n' "$json"
}

root_jsonl="$(mktemp)"
ref_cache="$(mktemp)"
trap 'rm -f "$root_jsonl" "$ref_cache"' EXIT
: > "$root_jsonl"

while IFS= read -r issue; do
  num="$(jq -r '.number' <<<"$issue")"
  title="$(jq -r '.title' <<<"$issue")"
  status="$(jq -r '.status' <<<"$issue")"

  # derive linked open-pr-link blocker
  no_link=false
  stale=false
  if jq -e --argjson n "$num" 'index($n)' <<<"$no_open_pr_link_issues" >/dev/null; then
    no_link=true
  fi
  if jq -e --argjson n "$num" 'index($n)' <<<"$stale_unassigned_issues" >/dev/null; then
    stale=true
  fi

  blockers=()
  if [[ "$status" == "BLOCKED" ]]; then
    blockers+=("blocked_refs")
  fi
  if [[ "$no_link" == true ]]; then
    blockers+=("no_open_pr_link")
  fi
  if [[ "$stale" == true ]]; then
    blockers+=("stale")
  fi

  blocker_reasons="$(printf '%s\n' "${blockers[@]}" | sed '/^$/d' | jq -R . | jq -s .)"

  open_refs="$(jq -c '.openRefs // []' <<<"$issue")"
  closed_refs="$(jq -c '.closedRefs // []' <<<"$issue")"

  resolved_open_refs="[]"
  open_ref_list=()
  for r in $(jq -r '.openRefs[]' <<<"$issue"); do
    ref_num="${r//#/}"
    ref_detail="$(resolve_ref "$ref_num")"
    open_ref_list+=("$ref_detail")
  done
  if [[ "${#open_ref_list[@]}" -gt 0 ]]; then
    resolved_open_refs="$(printf '%s\n' "${open_ref_list[@]}" | jq -s .)"
  fi

  candidate=false
  if jq -e --argjson n "$num" 'index($n)' <<<"$(jq -c 'map(.number)' <<<"$candidates")" >/dev/null; then
    candidate=true
  fi

  jq -cn \
    --argjson number "$num" \
    --arg title "$title" \
    --arg status "$status" \
    --argjson blockers "$blocker_reasons" \
    --argjson openRefs "$resolved_open_refs" \
    --argjson closedRefs "$closed_refs" \
    --argjson candidate "$candidate" \
    '{number:$number, title:$title, status:$status, candidate:$candidate, rootBlockers:$blockers, openRefs:$openRefs, closedRefs:$closedRefs}' \
    >> "$root_jsonl"
  echo >> "$root_jsonl"
done < <(jq -c '.issues[]' <<<"$issue_ref_payload")

root_items="$(jq -s . <<<"$(cat "$root_jsonl")")"

block_count="$(jq -r '[.[] | select((.status == "BLOCKED") or (.rootBlockers|length>0))] | length' <<<"$root_items")"
candidate_count="$(jq -r '[.[] | select(.candidate == true)] | length' <<<"$root_items")"

if [[ "$OUTPUT_JSON" == "1" ]]; then
  jq -nc \
    --arg repo "$REPO" \
    --argjson generatedAt "$(date +%s)" \
    --argjson blockerSummary "$(jq '.summary' <<<"$blocker_payload")" \
    --argjson blockerItems "$(jq '.blocking_issues' <<<"$blocker_payload")" \
    --argjson issueRefAudit "$issue_ref_payload" \
    --argjson candidates "$(jq '.candidates' <<<"$candidate_payload")" \
    --argjson items "$root_items" \
    --argjson blockingCount "$block_count" \
    --argjson candidateCount "$candidate_count" \
    '{repo:$repo, generatedAt:($generatedAt|tonumber), blockerSummary:$blockerSummary, blockingItems:$blockerItems, issueRefAudit:$issueRefAudit, candidates:$candidates, items:$items, blockingCount:$blockingCount, candidateCount:$candidateCount}'
  exit 0
fi

echo "# Review root cause (${REPO})"
echo "- generated: $(date -u +'%Y-%m-%d %H:%M:%SZ')"
echo

echo "## Blockers"
if [[ "$block_count" == "0" ]]; then
  echo "- no blockers found"
else
  jq -r '.[] | select((.status == "BLOCKED") or (.rootBlockers|length>0)) | .number as $n | .title as $t | "- #\($n) \($t)"
      + (if .status=="BLOCKED" then " [ref-blocked]" else "" end)
      + (if (.rootBlockers|length>0) then " [" + ((.rootBlockers | map(sub("_";"-")) ) | join(", ")) + "]" else "" end)
      + (if .candidate then " [candidate]" else "" end)' <<<"$root_items"

  echo
  echo "### ref-blocked issues"
  while IFS= read -r item; do
    num="$(jq -r '.number' <<<"$item")"
    title="$(jq -r '.title' <<<"$item")"
    open_refs="$(jq -r '.openRefs | if length==0 then "<none>" else (map("#" + (.number|tostring) + ":" + .state + ":" + .title) | join(", ")) end' <<<"$item")"
    echo "- #${num} ${title}"
    echo "  openRefs: ${open_refs}"
    echo
  done < <(jq -c '.[] | select(.status=="BLOCKED")' <<<"$root_items")

  echo "### link blockers"
  while IFS= read -r item; do
    num="$(jq -r '.number' <<<"$item")"
    title="$(jq -r '.title' <<<"$item")"
    if jq -e '.rootBlockers | index("no_open_pr_link")' <<<"$item" >/dev/null; then
      echo "- #${num} ${title}: no open PR link"
    fi
    if jq -e '.rootBlockers | index("stale")' <<<"$item" >/dev/null; then
      echo "- #${num} ${title}: stale >${STALE_DAYS}d"
    fi
  done < <(jq -c '.[]' <<<"$root_items")
fi

echo
echo "## Candidates"
echo "- count: ${candidate_count}"
while IFS= read -r item; do
  num="$(jq -r '.number' <<<"$item")"
  title="$(jq -r '.title' <<<"$item")"
  echo "- #${num} ${title}"
done < <(jq -c '.candidates[]' <<<"$candidate_payload")
