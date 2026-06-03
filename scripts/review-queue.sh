#!/usr/bin/env bash
set -euo pipefail

# One-command reviewer cockpit:
#   1) open PR audit
#   2) open issues audit
#   3) blocker digest (merge-blocked PR + unassigned stale/no-pr-link issue)
#   4) issue reference audit (open/closed refs)
#   5) consolidated root-cause snapshot (blockers + candidates)
#
# Usage:
#   scripts/review-queue.sh [options] [repo] [max_prs] [max_issues] [stale_days]
# Example:
#   scripts/review-queue.sh github.com/Eliaaazzz/live-auction-system 20 50 2
#   scripts/review-queue.sh --strict --markdown github.com/Eliaaazzz/live-auction-system 20 50 2

REPO="github.com/Eliaaazzz/live-auction-system"
MAX_PRS=30
MAX_ISSUES=50
STALE_DAYS=3
OUTPUT_JSON=0

BLOCKER_ARGS=()
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict|--markdown|--md|--json)
      if [[ "$1" == "--json" ]]; then
        OUTPUT_JSON=1
      fi
      BLOCKER_ARGS+=("$1")
      shift
      ;;
    --json-only)
      OUTPUT_JSON=1
      BLOCKER_ARGS+=("--json" "--json-only")
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  scripts/review-queue.sh [options] [repo] [max_prs] [max_issues] [stale_days]

Options:
  --strict     fail non-zero when blocker digest has any blocking item
  --markdown   render blocker digest as markdown
  --json       emit machine-readable payload (open PRs, issues, blocker digest, ref-audit, root-cause)
  --json-only  emit only machine-readable payload (open PRs, issues, blocker digest, ref-audit, root-cause)
  --help       show this help
EOF
      exit 0
      ;;
    --*)
      echo "Unknown flag: $1"
      exit 1
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
  MAX_PRS="${POSITIONAL[1]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 3 ]]; then
  MAX_ISSUES="${POSITIONAL[2]}"
fi
if [[ "${#POSITIONAL[@]}" -ge 4 ]]; then
  STALE_DAYS="${POSITIONAL[3]}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/review-open-prs.sh" "$SCRIPT_DIR/review-open-issues.sh" "$SCRIPT_DIR/review-blocker-digest.sh"

if (( OUTPUT_JSON == 1 )); then
  read_json_or_default() {
    local f="$1"
    local default_value="${2:-null}"
    if [[ -s "$f" ]]; then
      cat "$f"
    else
      echo "$default_value"
    fi
  }

  tmp_prs="$(mktemp)"
  tmp_issues="$(mktemp)"
  tmp_out="$(mktemp)"
  tmp_ref_audit="$(mktemp)"
  tmp_root_cause="$(mktemp)"
  tmp_priority="$(mktemp)"
  trap 'rm -f "$tmp_prs" "$tmp_issues" "$tmp_out" "$tmp_ref_audit" "$tmp_root_cause" "$tmp_priority"' EXIT
  "$SCRIPT_DIR/review-open-prs.sh" "$REPO" "$MAX_PRS" --json --json-only > "$tmp_prs"
  "$SCRIPT_DIR/review-open-issues.sh" "$REPO" "$MAX_ISSUES" "$STALE_DAYS" --json --json-only > "$tmp_issues"

  blocker_args=(--json --json-only)
  for arg in "${BLOCKER_ARGS[@]}"; do
    blocker_args+=("$arg")
  done

  blocker_status=0
  if "$SCRIPT_DIR/review-blocker-digest.sh" "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS" "${blocker_args[@]}" > "$tmp_out"; then
    blocker_status=0
  else
    blocker_status=$?
  fi
  ref_status=0
  if "$SCRIPT_DIR/review-issue-ref-audit.sh" "$REPO" "$MAX_ISSUES" "$STALE_DAYS" --json-only > "$tmp_ref_audit"; then
    ref_status=0
  else
    ref_status=$?
  fi

  root_status=0
  if "$SCRIPT_DIR/review-root-cause.sh" --json-only "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS" > "$tmp_root_cause"; then
    root_status=0
  else
    root_status=$?
  fi

  priority_status=0
  if "$SCRIPT_DIR/review-blocker-priority.sh" --json-only "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS" > "$tmp_priority"; then
    priority_status=0
  else
    priority_status=$?
  fi

  blocker_payload="$(read_json_or_default "$tmp_out" '{"type":"blocker-digest","error":"missing_payload"}')"
  ref_payload="$(read_json_or_default "$tmp_ref_audit" '{"type":"issue-ref-audit","error":"missing_payload"}')"
  root_payload="$(read_json_or_default "$tmp_root_cause" '{"type":"root-cause","error":"missing_payload"}')"
  priority_payload="$(read_json_or_default "$tmp_priority" '{"type":"blocker-priority","error":"missing_payload"}')"
  jq -cn \
    --arg repo "$REPO" \
    --argjson openPrs "$(cat "$tmp_prs")" \
    --argjson openIssues "$(cat "$tmp_issues")" \
    --argjson blocker "$blocker_payload" \
    --argjson issueRefAudit "$ref_payload" \
    --argjson rootCause "$root_payload" \
    --argjson blockerPriority "$priority_payload" \
    '{repo:$repo, openPrs:$openPrs, openIssues:$openIssues, blocker:$blocker, issueRefAudit:$issueRefAudit, rootCause:$rootCause, blockerPriority:$blockerPriority}'

  if (( blocker_status != 0 || ref_status != 0 || root_status != 0 || priority_status != 0 )); then
    exit 2
  fi
else
  "$SCRIPT_DIR/review-open-prs.sh" "$REPO" "$MAX_PRS"
  echo
  "$SCRIPT_DIR/review-open-issues.sh" "$REPO" "$MAX_ISSUES" "$STALE_DAYS"
  echo
  if (( ${#BLOCKER_ARGS[@]} == 0 )); then
    "$SCRIPT_DIR/review-blocker-digest.sh" "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS"
  else
    "$SCRIPT_DIR/review-blocker-digest.sh" "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS" "${BLOCKER_ARGS[@]}"
  fi
  echo
  "$SCRIPT_DIR/review-issue-ref-audit.sh" "$REPO" "$MAX_ISSUES" "$STALE_DAYS"
  echo
  "$SCRIPT_DIR/review-root-cause.sh" "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS"
  echo
  "$SCRIPT_DIR/review-blocker-priority.sh" "$REPO" "$MAX_PRS" "$MAX_ISSUES" "$STALE_DAYS"
fi
