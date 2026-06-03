#!/usr/bin/env bash
set -euo pipefail

# PR dependency + readiness reviewer.
# - Lists open PRs by default (or explicit PR numbers).
# - Extracts numeric PR references in body (Closes/Refs style #123 mentions).
# - Reports blockers: merge state / CI checks / dependency chain issues.
# - Supports plain-text and JSON outputs.
#
# Usage:
#   scripts/review-pr-dependency.sh [options] [repo] [pr1] [pr2] ...

usage() {
  cat <<'EOF'
Usage:
  scripts/review-pr-dependency.sh [options] [repo] [pr numbers...]

Options:
  --json        emit machine-readable JSON payload at the end
  --json-only   emit only machine JSON (implies --json)
  --open        review only open PRs (default)
  --closed      include closed PRs when numbers are explicitly passed
  -h, --help   show this help
EOF
}

REPO="github.com/Eliaaazzz/live-auction-system"
REVIEW_OPEN=1
REVIEW_CLOSED=0
OUTPUT_JSON=0
JSON_ONLY=0

PR_NUMBERS=()
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
    --open)
      REVIEW_OPEN=1
      REVIEW_CLOSED=0
      shift
      ;;
    --closed)
      REVIEW_CLOSED=1
      REVIEW_OPEN=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "unknown option: $1"
      usage
      exit 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ "${#POSITIONAL[@]}" -gt 0 ]]; then
  REPO="${POSITIONAL[0]}"
  if [[ "${#POSITIONAL[@]}" -gt 1 ]]; then
    PR_NUMBERS=("${POSITIONAL[@]:1}")
  else
    PR_NUMBERS=()
  fi
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "required: gh CLI not found"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "required: jq not found"
  exit 1
fi

if [[ "${#PR_NUMBERS[@]}" -eq 0 && "$REVIEW_OPEN" -eq 1 ]]; then
  PR_NUMBERS=()
  while IFS= read -r pr_num; do
    [[ -n "$pr_num" ]] && PR_NUMBERS+=("$pr_num")
  done < <(gh pr list --repo "$REPO" --state open --json number --jq '.[].number')
fi

if [[ "${#PR_NUMBERS[@]}" -eq 0 ]]; then
  if [[ "$OUTPUT_JSON" == "1" && "$JSON_ONLY" == "1" ]]; then
    jq -cn '[]'
    exit 0
  fi
  echo "No PRs selected for review."
  exit 0
fi

if [[ "$OUTPUT_JSON" == "1" ]]; then
  PR_RESULTS="$(mktemp)"
  trap 'rm -f "$PR_RESULTS"' EXIT
  : > "$PR_RESULTS"
fi

collect_pr_details() {
  local num="$1"
  local data=""
  if data="$(gh pr view "$num" --repo "$REPO" --json number,title,state,updatedAt,mergeStateStatus,reviewDecision,url,body,author,headRefName,baseRefName 2>/dev/null)"; then
    echo "PR:$data"
    return 0
  fi
  if data="$(gh issue view "$num" --repo "$REPO" --json number,title,state,updatedAt,body,url,author,createdAt,labels,assignees 2>/dev/null)"; then
    echo "ISSUE:$data"
    return 0
  fi
  echo "MISSING:{}"
  return 1
}

for pr in "${PR_NUMBERS[@]}"; do
  if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
    echo "skip non-numeric PR selector: ${pr}" >&2
    continue
  fi

  pr_json="$(gh pr view "$pr" --repo "$REPO" --json number,title,body,author,updatedAt,reviewDecision,mergeStateStatus,state,url,changedFiles,headRefName,baseRefName 2>/dev/null || true)"
  if [[ -z "$pr_json" ]]; then
    echo "warn: cannot read PR #${pr} from ${REPO}" >&2
    continue
  fi

  number="$(jq -r '.number' <<<"$pr_json")"
  title="$(jq -r '.title' <<<"$pr_json")"
  body="$(jq -r '.body // ""' <<<"$pr_json")"
  state="$(jq -r '.state' <<<"$pr_json")"
  merge_state="$(jq -r '.mergeStateStatus' <<<"$pr_json")"
  decision="$(jq -r '.reviewDecision // ""' <<<"$pr_json")"
  author="$(jq -r '.author.login // ""' <<<"$pr_json")"
  updated="$(jq -r '.updatedAt' <<<"$pr_json")"
  url="$(jq -r '.url' <<<"$pr_json")"
  head="$(jq -r '.headRefName' <<<"$pr_json")"
  base="$(jq -r '.baseRefName' <<<"$pr_json")"
  changed_count="$(jq -r '.changedFiles // 0' <<<"$pr_json")"

  check_json="$(gh pr checks "$pr" --repo "$REPO" --json name,state,workflow,link 2>/dev/null || true)"
  if [[ -z "$check_json" ]]; then
    check_json='[]'
  fi

  failed_checks_json="$(jq -r '.[] | select((.state|ascii_downcase) == "failure" or (.state|ascii_downcase) == "timed_out" or (.state|ascii_downcase) == "cancelled") | "\(.name) [\(.workflow)]"' <<<"$check_json" | jq -R . | jq -s . || echo '[]')"
  pending_checks_json="$(jq -r '.[] | select((.state|ascii_downcase) == "in_progress" or (.state|ascii_downcase) == "queued" or (.state|ascii_downcase) == "queued_awaiting" or (.state|ascii_downcase) == "pending") | "\(.name) [\(.workflow)]"' <<<"$check_json" | jq -R . | jq -s . || echo '[]')"
  failed_count="$(jq 'length' <<<"$failed_checks_json" 2>/dev/null || echo 0)"
  pending_count="$(jq 'length' <<<"$pending_checks_json" 2>/dev/null || echo 0)"
  passed_count="$(jq -r '.[] | select((.state|ascii_downcase) == "success" or (.state|ascii_downcase) == "completed") | .name' <<<"$check_json" | wc -l | tr -d ' ')"
  check_total="$(jq 'length' <<<"$check_json")"

  dep_raw_refs="$(printf '%s\n' "$body" | grep -Eo '#[0-9]+' | sed 's/#//g' | sort -u || true)"
  dep_refs=""
  dep_payload_file="$(mktemp)"
  blocker_lines_file="$(mktemp)"

  if [[ -n "$dep_raw_refs" ]]; then
    dep_refs=""
    while IFS= read -r dep; do
      [[ -z "$dep" ]] && continue
      if [[ "$dep" == "$number" ]]; then
        continue
      fi
      if [[ -z "$dep_refs" ]]; then
        dep_refs="#${dep}"
      else
        dep_refs="${dep_refs} #${dep}"
      fi

      dep_payload="$(collect_pr_details "$dep")"
      dep_kind="${dep_payload%%:*}"
      dep_json="${dep_payload#*:}"

      if [[ "$dep_kind" == "MISSING" ]]; then
        echo "dependency #${dep} missing_or_inaccessible" >> "$blocker_lines_file"
        continue
      fi
      if [[ "$dep_kind" == "ISSUE" ]]; then
        is_issue_ref=1
      else
        is_issue_ref=0
      fi

      dep_title="$(jq -r '.title // ""' <<<"$dep_json")"
      dep_state="$(jq -r '.state // ""' <<<"$dep_json")"
      if [[ "$is_issue_ref" == "1" ]]; then
        dep_merge="N/A"
      else
        dep_merge="$(jq -r '.mergeStateStatus // ""' <<<"$dep_json")"
      fi
      dep_updated="$(jq -r '.updatedAt // ""' <<<"$dep_json")"
      dep_url="$(jq -r '.url // ""' <<<"$dep_json")"
      dep_kind_name="$( [[ "$is_issue_ref" == "1" ]] && echo "issue" || echo "pr")"

      if [[ "$is_issue_ref" == "0" ]]; then
        if [[ "$dep_state" == "OPEN" ]]; then
          if [[ "$dep_merge" != "CLEAN" ]]; then
            echo "dependency #${dep} mergeState=${dep_merge}" >> "$blocker_lines_file"
          fi
        elif [[ "$dep_state" != "MERGED" && -n "$dep_state" ]]; then
          echo "dependency #${dep} not-open (${dep_state})" >> "$blocker_lines_file"
        fi
      fi

      jq -cn \
        --argjson number "$dep" \
        --arg title "$dep_title" \
        --arg state "$dep_state" \
        --arg mergeState "$dep_merge" \
        --arg updatedAt "$dep_updated" \
        --arg url "$dep_url" \
        --arg kind "$dep_kind_name" \
        '{number: $number, title: $title, state: $state, kind: $kind, mergeState: $mergeState, updatedAt: $updatedAt, url: $url}' \
        >> "$dep_payload_file"
      echo >> "$dep_payload_file"
    done <<< "$dep_raw_refs"
  fi

  blocker_lines=()
  blocker_count=0
  if [[ "$state" != "OPEN" && "$REVIEW_CLOSED" -eq 0 ]]; then
    blocker_lines+=("state=${state}")
    blocker_count=$((blocker_count + 1))
  fi
  if [[ "$state" == "OPEN" && "$merge_state" != "CLEAN" ]]; then
    blocker_lines+=("merge_state=${merge_state}")
    blocker_count=$((blocker_count + 1))
  fi
  if (( failed_count > 0 )); then
    blocker_lines+=("checks_failed=$(jq -r 'join("; ")' <<<"$failed_checks_json")")
    blocker_count=$((blocker_count + 1))
  elif (( pending_count > 0 )); then
    blocker_lines+=("checks_pending=$(jq -r 'join("; ")' <<<"$pending_checks_json")")
    blocker_count=$((blocker_count + 1))
  fi

  if [[ -s "$blocker_lines_file" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      blocker_lines+=("$line")
      blocker_count=$((blocker_count + 1))
    done < "$blocker_lines_file"
  fi

  if [[ -z "$dep_refs" ]]; then
    dep_refs="<none>"
  fi

  status="READY"
  if (( blocker_count > 0 )); then
    status="BLOCKING"
  fi

  blockers_json='[]'
  if (( ${#blocker_lines[@]} > 0 )); then
    blockers_json="$(printf '%s\n' "${blocker_lines[@]}" | jq -R . | jq -s .)"
  fi
  dep_payload_json="$(jq -s . < "$dep_payload_file" || echo '[]')"
  checks_json="$(jq -nc \
    --argjson total "$check_total" \
    --argjson passed "$passed_count" \
    --argjson failed "$failed_checks_json" \
    --argjson pending "$pending_checks_json" \
    '{total: $total, passed: $passed, failed: $failed, pending: $pending}')"

  rm -f "$dep_payload_file" "$blocker_lines_file"

  if [[ "$OUTPUT_JSON" == "1" ]]; then
    jq -nc \
      --argjson number "$number" \
      --arg title "$title" \
      --arg status "$status" \
      --arg author "$author" \
      --arg updatedAt "$updated" \
      --arg mergeState "$merge_state" \
      --arg reviewDecision "$decision" \
      --arg state "$state" \
      --arg url "$url" \
      --arg head "$head" \
      --arg base "$base" \
      --argjson changedFiles "$changed_count" \
      --arg refs "$dep_refs" \
      --argjson blockers "$blockers_json" \
      --argjson dependencies "$dep_payload_json" \
      --argjson checks "$checks_json" \
      '{number:$number, title:$title, status:$status, author:$author, updatedAt:$updatedAt, mergeState:$mergeState, reviewDecision:$reviewDecision, state:$state, url:$url, branch:{head:$head, base:$base}, changedFiles:($changedFiles|tonumber), dependencyRefs:$refs, blockers:$blockers, dependencyDetails:$dependencies, checks:$checks}' \
      >> "$PR_RESULTS"
    echo >> "$PR_RESULTS"
  else
    echo "## PR #${number} ${title}"
    echo "status: ${status} | state: ${state} | mergeState: ${merge_state} | reviewDecision: ${decision:-N/A}"
    echo "author: ${author} | updatedAt: ${updated}"
    echo "branch: ${head} -> ${base}"
    echo "changed files: ${changed_count}"
    echo "references: ${dep_refs}"
    if (( check_total > 0 )); then
      echo "checks: passed=${passed_count}/${check_total}"
    else
      echo "checks: <none>"
    fi
    if (( failed_count > 0 )); then
      echo "checks failed:"
      while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        echo "  - ${f}"
      done < <(jq -r '.[]' <<<"$failed_checks_json")
    fi
    if (( pending_count > 0 )); then
      echo "checks pending:"
      while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        echo "  - ${p}"
      done < <(jq -r '.[]' <<<"$pending_checks_json")
    fi
    if (( blocker_count > 0 )); then
      echo "blockers:"
      for line in "${blocker_lines[@]}"; do
        echo "  - ${line}"
      done
    else
      echo "blockers: <none>"
    fi
    echo "url: ${url}"
    echo
  fi
done

if [[ "$OUTPUT_JSON" == "1" ]]; then
  if [[ "$JSON_ONLY" == "1" ]]; then
    jq -cs '.' "$PR_RESULTS"
    exit 0
  fi

  jq -cs '.' "$PR_RESULTS"
  echo
fi
