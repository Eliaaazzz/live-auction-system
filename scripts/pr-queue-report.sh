#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/pr-queue-report.sh [--limit N] [--format markdown|tsv] [--out FILE]

Summarize the open GitHub pull-request queue for reviewer triage.

The report is read-only. It uses `gh pr list` and `jq`, does not read secrets,
and does not modify branches, issues, or pull requests.

Environment overrides:
  LIMIT=80
  FORMAT=markdown
USAGE
}

LIMIT="${LIMIT:-80}"
FORMAT="${FORMAT:-markdown}"
OUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --format)
      FORMAT="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$FORMAT" in
  markdown|tsv) ;;
  *)
    echo "--format must be markdown or tsv" >&2
    exit 2
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

json_file=$(mktemp "${TMPDIR:-/tmp}/lumen-pr-queue.XXXXXX.json")
trap 'rm -f "$json_file"' EXIT HUP INT TERM

gh pr list --state open --limit "$LIMIT" \
  --json number,title,author,baseRefName,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt,url \
  > "$json_file"

jq_filter='def check_state:
  ([.statusCheckRollup[]? | select(.__typename == "CheckRun") | .conclusion] | unique) as $c |
  if ($c | index("FAILURE")) then "ci-failing"
  elif ($c | index("CANCELLED")) then "ci-cancelled"
  elif ($c | length) == 0 then "ci-missing"
  elif ($c | all(. == "SUCCESS")) then "ci-green"
  else "ci-pending"
  end;
def lane:
  check_state as $ci |
  if .isDraft then "draft"
  elif $ci == "ci-failing" or .reviewDecision == "CHANGES_REQUESTED" then "blocked"
  elif .reviewDecision == "APPROVED" and $ci == "ci-green" then "merge-candidate"
  elif $ci == "ci-green" then "needs-review"
  else "waiting-ci"
  end;
def review_state:
  if .isDraft then "DRAFT"
  elif .reviewDecision == "APPROVED" then "APPROVED"
  elif .reviewDecision == "CHANGES_REQUESTED" then "CHANGES_REQUESTED"
  else "REVIEW_REQUIRED"
  end;
def stack_state:
  if (.baseRefName == "main" or .baseRefName == "master") then "direct"
  else "stacked"
  end;
def row:
  {
    number,
    title,
    lane: lane,
    stack: stack_state,
    ci: check_state,
    review: review_state,
    draft: .isDraft,
    author: .author.login,
    base: .baseRefName,
    head: .headRefName,
    updatedAt,
    url
  };
map(row) as $rows |
($rows | map({key: .head, value: {number, lane, ci, review, url}}) | from_entries) as $by_head |
$rows | map(
  . as $r |
  ($by_head[$r.base] // null) as $base_pr |
  . + {
    basePr: (if $base_pr then ("#" + ($base_pr.number | tostring)) else "" end),
    baseLane: ($base_pr.lane // ""),
    handoff: (
      if .stack == "stacked" and $base_pr and .lane == "merge-candidate" then "ready-after-base"
      elif .stack == "stacked" and $base_pr then "wait-base"
      elif .stack == "stacked" then "external-base"
      else ""
      end
    )
  }
)'

rows=$(jq -c "$jq_filter" "$json_file")

write_report() {
  if [ "$FORMAT" = "tsv" ]; then
    printf 'lane\tstack\thandoff\tbase_pr\tbase_lane\tci\treview\tpr\tauthor\tbase\thead\tupdated\ttitle\turl\n'
    printf '%s\n' "$rows" | jq -r '.[] | [.lane,.stack,.handoff,.basePr,.baseLane,.ci,.review,("#" + (.number|tostring)),.author,.base,.head,.updatedAt,.title,.url] | @tsv'
    return
  fi

  generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  total=$(printf '%s\n' "$rows" | jq 'length')
  merge_candidates=$(printf '%s\n' "$rows" | jq '[.[] | select(.lane == "merge-candidate")] | length')
  needs_review=$(printf '%s\n' "$rows" | jq '[.[] | select(.lane == "needs-review")] | length')
  blocked=$(printf '%s\n' "$rows" | jq '[.[] | select(.lane == "blocked")] | length')
  draft=$(printf '%s\n' "$rows" | jq '[.[] | select(.lane == "draft")] | length')
  waiting_ci=$(printf '%s\n' "$rows" | jq '[.[] | select(.lane == "waiting-ci")] | length')
  review_required=$(printf '%s\n' "$rows" | jq '[.[] | select(.review == "REVIEW_REQUIRED")] | length')
  direct=$(printf '%s\n' "$rows" | jq '[.[] | select(.stack == "direct")] | length')
  stacked=$(printf '%s\n' "$rows" | jq '[.[] | select(.stack == "stacked")] | length')
  ready_after_base=$(printf '%s\n' "$rows" | jq '[.[] | select(.handoff == "ready-after-base")] | length')

  cat <<EOF_REPORT
# Lumen PR queue report

Generated: $generated_at

| bucket | count |
|---|---:|
| merge-candidate | $merge_candidates |
| needs-review | $needs_review |
| blocked | $blocked |
| draft | $draft |
| waiting-ci | $waiting_ci |
| review-required | $review_required |
| direct-to-main | $direct |
| stacked | $stacked |
| ready-after-base | $ready_after_base |
| total open | $total |

## Open PRs

| lane | stack | handoff | base PR | CI | review | PR | author | base <- head | title |
|---|---|---|---|---|---|---|---|---|---|
EOF_REPORT
  printf '%s\n' "$rows" | jq -r '.[] | "| " + .lane + " | " + .stack + " | " + .handoff + " | " + (.basePr // "") + " " + (.baseLane // "") + " | " + .ci + " | " + (.review // "") + " | [#" + (.number|tostring) + "](" + .url + ") | " + .author + " | `" + .base + " <- " + .head + "` | " + (.title | gsub("\\|"; "\\|")) + " |"'
}

if [ -n "$OUT" ]; then
  write_report > "$OUT"
  printf 'wrote %s\n' "$OUT"
else
  write_report
fi
