#!/usr/bin/env bash
set -euo pipefail

# Map open issue references to open/closed status for review triage.
#
# Usage:
#   scripts/review-issue-ref-audit.sh [options] [repo] [issueLimit] [staleDays]
#
# Output:
#   - human-readable table by default
#   - --json for machine mode

usage() {
  cat <<'EOF'
Usage:
  scripts/review-issue-ref-audit.sh [options] [repo] [issueLimit] [staleDays]

Options:
  --json        emit machine-readable JSON
  --json-only   emit only machine-readable JSON
  --help        show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
MAX_OPEN=80
STALE_DAYS=3
OUTPUT_JSON=0
OUTPUT_JSON_ONLY=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --json-only)
      OUTPUT_JSON=1
      OUTPUT_JSON_ONLY=1
      shift
      ;;
    --help|-h)
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
  echo "required: gh"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq"
  exit 1
fi

issues_payload="$(scripts/review-open-issues.sh --json-only "$REPO" "$MAX_OPEN" "$STALE_DAYS")"
if ! jq -e '.open_issues|type=="array"' <<<"$issues_payload" >/dev/null; then
  echo "failed to parse issue payload"
  exit 1
fi

resolve_ref_state() {
  local ref="$1"
  local state=""
  local cached_state

  cached_state="$(awk -F'\t' -v ref="$ref" '$1 == ref { print $2; exit }' "$ref_cache" || true)"
  if [[ -n "$cached_state" ]]; then
    echo "$cached_state"
    return 0
  fi

  if state="$(gh pr view "$ref" --repo "$REPO" --json state 2>/dev/null | jq -r '.state // ""')"; then
    printf '%s\t%s\n' "$ref" "$state" >> "$ref_cache"
    echo "$state"
    return 0
  fi

  if state="$(gh issue view "$ref" --repo "$REPO" --json state 2>/dev/null | jq -r '.state // ""')"; then
    printf '%s\t%s\n' "$ref" "$state" >> "$ref_cache"
    echo "$state"
    return 0
  fi

  printf '%s\t%s\n' "$ref" "MISSING" >> "$ref_cache"
  echo "MISSING"
}

ref_audit_jsonl="$(mktemp)"
ref_cache="$(mktemp)"
trap 'rm -f "$ref_audit_jsonl" "$ref_cache"' EXIT

issue_count=0
candidate_count=0
blocked_count=0
skipped_count=0

while IFS= read -r issue; do
  issue_count=$((issue_count + 1))
  num="$(jq -r '.number' <<<"$issue")"
  title="$(jq -r '.title' <<<"$issue")"
  assignees="$(jq -r '.assignees | length' <<<"$issue")"
  linked_prs="$(jq -r '.linkedOpenPRs | length' <<<"$issue")"
  refs="$(jq -c '.bodyIssueRefs // []' <<<"$issue")"

  # Only audit unassigned + no open-PR-linked issues. Others are intentionally skipped
  # in the ref-audit view but still counted toward the total-open-issues floor.
  if [[ "$assignees" -gt 0 || "$linked_prs" -gt 0 ]]; then
    skipped_count=$((skipped_count + 1))
    continue
  fi

  open_refs=()
  closed_refs=()
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    state="$(resolve_ref_state "$ref")"
    if [[ "$state" == "OPEN" ]]; then
      open_refs+=("#$ref")
    else
      closed_refs+=("#$ref")
    fi
  done < <(jq -r '.[]' <<<"$refs")

  open_refs_arr='[]'
  closed_refs_arr='[]'
  if ((${#open_refs[@]} > 0)); then
    open_refs_arr="$(printf '%s\n' "${open_refs[@]}" | jq -R . | jq -s .)"
  fi
  if ((${#closed_refs[@]} > 0)); then
    closed_refs_arr="$(printf '%s\n' "${closed_refs[@]}" | jq -R . | jq -s .)"
  fi

  status="BLOCKED"
  if (( ${#open_refs[@]} == 0 )); then
    candidate_count=$((candidate_count + 1))
    status="CANDIDATE"
  else
    blocked_count=$((blocked_count + 1))
  fi

  jq -cn \
    --argjson n "$num" \
    --arg title "$title" \
    --arg status "$status" \
    --argjson openRefs "$open_refs_arr" \
    --argjson closedRefs "$closed_refs_arr" \
    '{number:$n, title:$title, status:$status, openRefs:$openRefs, closedRefs:$closedRefs}' \
    >> "$ref_audit_jsonl"
  echo >> "$ref_audit_jsonl"
done < <(jq -c '.open_issues[]' <<<"$issues_payload")

if (( OUTPUT_JSON == 1 )); then
  if [[ -s "$ref_audit_jsonl" ]]; then
    issue_audit="$(cat "$ref_audit_jsonl" | jq -s .)"
  else
    issue_audit='[]'
  fi
  jq -cn \
  --arg repo "$REPO" \
  --argjson total "$issue_count" \
  --argjson candidates "$candidate_count" \
  --argjson blocked "$blocked_count" \
  --argjson skipped "$skipped_count" \
  --argjson items "$issue_audit" \
    '{repo:$repo, totalOpenIssues:$total, candidateCount:$candidates, blockedCount:$blocked, skippedCount:$skipped, issues:$items}'
fi

if (( OUTPUT_JSON_ONLY == 1 || OUTPUT_JSON == 1 )); then
  exit 0
fi

echo "repo: ${REPO}"
echo "totalOpenIssuesAudited: ${issue_count}"
echo "candidate: ${candidate_count} | blockedByOpenRefs: ${blocked_count}"
echo
if [[ ! -s "$ref_audit_jsonl" ]]; then
  echo "(no candidate/blocked issues matched the audit criteria)"
  exit 0
fi
while IFS= read -r item; do
  num="$(jq -r '.number' <<<"$item")"
  title="$(jq -r '.title' <<<"$item")"
  status="$(jq -r '.status' <<<"$item")"
  if [[ "$status" == "CANDIDATE" ]]; then
    echo "- #${num} ${title} [candidate]"
  else
    echo "- #${num} ${title} [blocked]"
    jq -r '.openRefs[]' <<<"$item" | sed 's/^/  open-ref: /'
  fi
  echo
done < <(jq -c '.' "$ref_audit_jsonl")
