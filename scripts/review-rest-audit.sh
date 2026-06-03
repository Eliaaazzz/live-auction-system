#!/usr/bin/env bash
set -euo pipefail

# REST-only review audit for GitHub API (works when GraphQL/gh checks are unavailable).
#
# Usage:
#   scripts/review-rest-audit.sh [options] [repo] [maxOpenIssues] [staleDays]

usage() {
  cat <<'USAGE'
Usage:
  scripts/review-rest-audit.sh [options] [repo] [maxOpenIssues] [staleDays]

Options:
  --json        emit machine JSON payload
  --json-only   emit machine JSON payload only
  --help        show this help
USAGE
}

REPO="github.com/Eliaaazzz/live-auction-system"
MAX_OPEN=80
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

if [[ ${#POSITIONAL[@]} -ge 1 ]]; then
  REPO="${POSITIONAL[0]}"
fi
if [[ ${#POSITIONAL[@]} -ge 2 ]]; then
  MAX_OPEN="${POSITIONAL[1]}"
fi
if [[ ${#POSITIONAL[@]} -ge 3 ]]; then
  STALE_DAYS="${POSITIONAL[2]}"
fi

if ! [[ "$MAX_OPEN" =~ ^[0-9]+$ ]]; then
  echo "invalid maxOpenIssues: $MAX_OPEN"
  exit 2
fi
if ! [[ "$STALE_DAYS" =~ ^[0-9]+$ ]]; then
  echo "invalid staleDays: $STALE_DAYS"
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "required: curl"
  exit 1
fi

GH_TOKEN_VALUE="${GH_TOKEN:-}"
if [[ -z "$GH_TOKEN_VALUE" ]]; then
  if command -v gh >/dev/null 2>&1; then
    GH_TOKEN_VALUE="$(gh auth token 2>/dev/null || true)"
    if [[ -z "$GH_TOKEN_VALUE" ]]; then
      GH_TOKEN_VALUE="$(gh token 2>/dev/null || true)"
    fi
  fi
fi

if [[ -z "$GH_TOKEN_VALUE" ]]; then
  echo "required: GH_TOKEN"
  exit 1
fi

OWNER_REPO="${REPO#https://}"
OWNER_REPO="${OWNER_REPO#http://}"
OWNER_REPO="${OWNER_REPO#github.com/}"
OWNER_REPO="${OWNER_REPO#/}"

API_BASE="https://api.github.com/repos/${OWNER_REPO}"

api_json() {
  local url="$1"
  curl -fsS \
    -H "Authorization: token ${GH_TOKEN_VALUE}" \
    -H "Accept: application/vnd.github.v3+json" \
    "$url"
}

to_epoch() {
  local s="$1"
  local out=""
  out="$(date -u -d "$s" +%s 2>/dev/null || true)"
  if [[ -z "$out" ]]; then
    out="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$s" +%s 2>/dev/null || true)"
  fi
  if [[ -z "$out" ]]; then
    echo 0
  else
    echo "$out"
  fi
}

json_array_from_items() {
  local values="$1"

  values="$(printf '%s\n' "$values" | sed '/^$/d')"
  if [[ -z "$values" ]]; then
    echo '[]'
    return
  fi

  printf '%s\n' "$values" | jq -R . | jq -s .
}

fetch_open_items_jsonl() {
  local endpoint="$1"
  local query="$2"
  local max_items="$3"
  local out_jsonl="$4"

  : > "$out_jsonl"
  local page=1
  local fetched=0

  while true; do
    local remaining=$((max_items - fetched))
    if (( remaining <= 0 )); then
      break
    fi

    local page_size=100
    if (( remaining < page_size )); then
      page_size=$remaining
    fi

    local url="${API_BASE}/${endpoint}?${query}&per_page=${page_size}&page=${page}"
    local page_json
    page_json="$(api_json "$url")"

    local got
    got="$(jq 'length' <<<"$page_json")"
    if [[ "$got" == "0" ]]; then
      break
    fi

    jq -c '.[]' <<<"$page_json" >> "$out_jsonl"
    fetched=$((fetched + got))

    if (( got < page_size )); then
      break
    fi

    page=$((page + 1))
  done
}

now_ts="$(date -u +%s)"
NL=$'\n'

tmp_prs=$(mktemp)
tmp_issues=$(mktemp)
tmp_items=$(mktemp)
tmp_candidates=$(mktemp)
tmp_blockers=$(mktemp)
tmp_open_pr_numbers=$(mktemp)
tmp_ref_cache=$(mktemp)

cleanup() {
  rm -f "$tmp_prs" "$tmp_issues" "$tmp_items" "$tmp_candidates" "$tmp_blockers" "$tmp_open_pr_numbers" "$tmp_ref_cache"
}
trap cleanup EXIT

fetch_open_items_jsonl "pulls" "state=open&sort=updated&direction=desc" "$MAX_OPEN" "$tmp_prs"
fetch_open_items_jsonl "issues" "state=open&sort=updated&direction=desc" "$MAX_OPEN" "$tmp_issues"

open_pr_count="$(wc -l < "$tmp_prs" | tr -d ' ')"
open_pr_count=${open_pr_count:-0}

# Keep full open-issue total for context.
open_issue_count="$(jq -s '[.[] | select(has("pull_request") | not)] | length' "$tmp_issues" 2>/dev/null || echo 0)"

# Cache open PR numbers to quickly mark explicit open-PR links in issue body text.
jq -r '.number // empty' "$tmp_prs" > "$tmp_open_pr_numbers"

is_open_pr() {
  local ref="$1"

  grep -Fxq "$ref" "$tmp_open_pr_numbers"
}

# Cache referenced item state so repeated refs only hit API once.
get_ref_state() {
  local ref="$1"
  local cached_state
  cached_state="$(awk -F'\t' -v ref="$ref" '$1 == ref { print $2; exit }' "$tmp_ref_cache" || true)"

  if [[ -n "$cached_state" ]]; then
    echo "$cached_state"
    return
  fi

  local payload=""
  payload="$(api_json "${API_BASE}/issues/${ref}" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    cached_state="MISSING"
  else
    cached_state="$(jq -r '.state // "MISSING"' <<<"$payload")"
  fi

  printf '%s\t%s\n' "$ref" "$cached_state" >> "$tmp_ref_cache"
  echo "$cached_state"
}

while IFS= read -r issue; do
  number="$(jq -r '.number' <<<"$issue")"
  title="$(jq -r '.title // ""' <<<"$issue")"
  assignees="$(jq -r '(.assignees | length // 0)' <<<"$issue")"

  # only triage unassigned issues not already linked to open PRs
  linked_open_prs=""
  refs=$(jq -r '.body // ""' <<<"$issue" | grep -Eo '#[0-9]+' | tr -d '#' | sort -u || true)
  if [[ -n "$refs" ]]; then
    while IFS= read -r ref; do
      [[ -z "$ref" ]] && continue
      if is_open_pr "$ref"; then
        linked_open_prs="${linked_open_prs}#${ref}${NL}"
      fi
    done <<<"$refs"
  fi

  if [[ "$assignees" != "0" ]] || [[ -n "$(printf '%s' "$linked_open_prs" | sed '/^$/d')" ]]; then
    continue
  fi

  if [[ -n "$refs" ]]; then
    open_refs=""
    closed_refs=""
      while IFS= read -r ref; do
        [[ -z "$ref" ]] && continue
        state="$(get_ref_state "$ref")"
        if [[ "$state" == "open" ]]; then
        open_refs="${open_refs}#${ref}${NL}"
        else
        closed_refs="${closed_refs}#${ref}${NL}"
        fi
    done <<<"$refs"
  else
    open_refs=""
    closed_refs=""
  fi

  updated_at="$(jq -r '.updated_at // .created_at // ""' <<<"$issue")"
  age_days=0
  stale=false
  if [[ -n "$updated_at" ]]; then
    updated_ts="$(to_epoch "$updated_at")"
    age_days=$(( (now_ts - updated_ts) / 86400 ))
    if (( age_days > STALE_DAYS )); then
      stale=true
    fi
  fi

  status="CANDIDATE"
  open_ref_count="$(printf '%s\n' "$(printf '%s' "$open_refs" | sed '/^$/d')" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ -z "$open_ref_count" ]]; then
    open_ref_count=0
  fi
  if (( open_ref_count > 0 )); then
    status="BLOCKED"
  fi

  jq -cn \
    --argjson number "$number" \
    --arg title "$title" \
    --arg status "$status" \
    --argjson assignees "$assignees" \
    --argjson ageDays "$age_days" \
    --arg updatedAt "$updated_at" \
    --argjson stale "$stale" \
    --argjson linkedOpenPRs "$(json_array_from_items "$linked_open_prs")" \
    --argjson openRefs "$(json_array_from_items "$open_refs")" \
    --argjson closedRefs "$(json_array_from_items "$closed_refs")" \
    '{
      number: $number,
      title: $title,
      status: $status,
      assignees: $assignees,
      ageDays: $ageDays,
      stale: $stale,
      updatedAt: $updatedAt,
      linkedOpenPRs: $linkedOpenPRs,
      openRefs: $openRefs,
      closedRefs: $closedRefs
    }' >> "$tmp_items"

    if [[ "$status" == "BLOCKED" ]]; then
      cat "$tmp_items" | tail -n 1 >> "$tmp_blockers"
    else
      cat "$tmp_items" | tail -n 1 >> "$tmp_candidates"
    fi

done < <(jq -c 'select(has("pull_request") | not)' "$tmp_issues")

items_payload='[]'
candidates_payload='[]'
blockers_payload='[]'
if [[ -s "$tmp_items" ]]; then
  items_payload="$(jq -s . "$tmp_items")"
fi
if [[ -s "$tmp_candidates" ]]; then
  candidates_payload="$(jq -s . "$tmp_candidates")"
fi
if [[ -s "$tmp_blockers" ]]; then
  blockers_payload="$(jq -s . "$tmp_blockers")"
fi

candidate_count="$(jq 'length' <<<"$candidates_payload")"
blocked_count="$(jq 'length' <<<"$blockers_payload")"
stale_count="$(jq -n --argjson items "$items_payload" '$items | map(select(.stale == true)) | length')"
unassigned_no_open_pr_link_count="$(jq 'length' <<<"$items_payload")"

# Stable output ordering, blockers first then candidates.
priority_payload="$(jq -cn \
  --argjson blockerList "$blockers_payload" \
  --argjson candidateList "$candidates_payload" \
  '{blockerPriority:($blockerList|sort_by(-(.openRefs|length), .number)), candidatePriority:($candidateList|sort_by(.number))}')"

counts="$(jq -nc \
  --argjson openPrs "$open_pr_count" \
  --argjson openIssues "$open_issue_count" \
  --argjson staleIssueAlerts "$stale_count" \
  --argjson unassignedIssueAlerts "$unassigned_no_open_pr_link_count" \
  --argjson blockedPr 0 \
  '{open_prs:$openPrs, open_issues:$openIssues, stale_unassigned_issue_alerts:$staleIssueAlerts, unassigned_no_open_pr_link_alerts:$unassignedIssueAlerts, blocking_total:($unassignedIssueAlerts + $staleIssueAlerts), blocking_prs:$blockedPr}')"

audit_payload="$(jq -cn \
  --arg repo "$REPO" \
  --argjson generatedAt "$now_ts" \
  --argjson counts "$counts" \
  --argjson candidateCount "$candidate_count" \
  --argjson blockingCount "$blocked_count" \
  --argjson items "$items_payload" \
  --argjson candidates "$candidates_payload" \
  --argjson blockers "$blockers_payload" \
  --argjson priority "$priority_payload" \
  '{repo:$repo, generatedAt:($generatedAt|tonumber), counts:$counts, candidateCount:$candidateCount, blockingCount:$blockingCount, items:$items, candidates:$candidates, blockers:$blockers, priority:$priority}')"

if (( OUTPUT_JSON == 1 )); then
  echo "$audit_payload"
  exit 0
fi

echo "# REST-only review audit (${REPO})"
echo "- generated: $(date -u +'%Y-%m-%d %H:%M:%SZ')"
echo "open prs: ${open_pr_count}"
echo "open issues (non-PR): ${open_issue_count}"
echo "unassigned + no open-PR-link (audited): ${unassigned_no_open_pr_link_count}"
echo "blocked: ${blocked_count} | candidates: ${candidate_count} | stale(> ${STALE_DAYS}d): ${stale_count}"

echo

echo "## Blocked"
if (( blocked_count == 0 )); then
  echo "- none"
else
  jq -r '.[] | "- #\(.number) \(.title) openRefs=" + (if (.openRefs|length>0) then (.openRefs|join(",")) else "<none>" end)' <<<"$blockers_payload"
fi

echo

echo "## Candidates"
if (( candidate_count == 0 )); then
  echo "- none"
else
  jq -r '.[] | "- #\(.number) \(.title)"' <<<"$candidates_payload"
fi
