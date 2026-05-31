#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/review-stacked-fixes.sh [--limit N] [--format markdown|tsv] [--json|--json-only] [--out FILE]

Find open PRs that are blocked, then show whether an open stacked child PR is
already ready to merge into that blocked branch.

This is read-only. It uses `gh pr list` and `jq`; it does not modify branches,
issues, or pull requests.

A child PR is considered `fix-ready` when:
  - child.baseRefName == blocked.headRefName
  - child is not draft
  - child reviewDecision == APPROVED
  - all reported check runs succeeded

Environment overrides:
  LIMIT=100
  FORMAT=markdown
  OUTPUT_JSON=0
  JSON_ONLY=0
USAGE
}

LIMIT="${LIMIT:-100}"
FORMAT="${FORMAT:-markdown}"
OUTPUT_JSON="${OUTPUT_JSON:-0}"
JSON_ONLY="${JSON_ONLY:-0}"
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
    --json)
      OUTPUT_JSON=1
      shift
      ;;
    --json-only)
      OUTPUT_JSON=1
      JSON_ONLY=1
      shift
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

json_file=$(mktemp "${TMPDIR:-/tmp}/lumen-stacked-fixes.XXXXXX.json")
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
def row:
  {
    number,
    title,
    author: .author.login,
    base: .baseRefName,
    head: .headRefName,
    review: (.reviewDecision // ""),
    draft: .isDraft,
    ci: check_state,
    lane: lane,
    updatedAt,
    url
  };
map(row) as $rows |
[$rows[] | select(.lane == "blocked" or .lane == "draft") as $blocked |
  ($rows | map(select(.base == $blocked.head)) | sort_by(.number)) as $children |
  $children[]? |
  . as $child |
  {
    blockedNumber: $blocked.number,
    blockedTitle: $blocked.title,
    blockedHead: $blocked.head,
    blockedLane: $blocked.lane,
    blockedReview: $blocked.review,
    blockedCi: $blocked.ci,
    blockedUrl: $blocked.url,
    fixNumber: $child.number,
    fixTitle: $child.title,
    fixHead: $child.head,
    fixLane: $child.lane,
    fixReview: $child.review,
    fixCi: $child.ci,
    fixDraft: $child.draft,
    fixUrl: $child.url,
    handoff: (if ($child.lane == "merge-candidate") then "fix-ready" else "fix-not-ready" end)
  }
] | sort_by(.blockedNumber, .fixNumber)'

rows=$(jq -c "$jq_filter" "$json_file")

write_json() {
  generated_at=$(date -u +%s)
  printf '%s\n' "$rows" | jq --argjson generatedAt "$generated_at" --argjson limit "$LIMIT" '{
    generatedAt: $generatedAt,
    limit: $limit,
    summary: {
      totalHandoffs: length,
      fixReady: ([.[] | select(.handoff == "fix-ready")] | length),
      fixNotReady: ([.[] | select(.handoff == "fix-not-ready")] | length)
    },
    handoffs: .
  }'
}

write_report() {
  if [ "$FORMAT" = "tsv" ]; then
    printf 'handoff\tblocked_pr\tblocked_lane\tblocked_review\tblocked_ci\tfix_pr\tfix_lane\tfix_review\tfix_ci\tblocked_head\tfix_head\tblocked_title\tfix_title\n'
    printf '%s\n' "$rows" | jq -r '.[] | [.handoff,("#" + (.blockedNumber|tostring)),.blockedLane,.blockedReview,.blockedCi,("#" + (.fixNumber|tostring)),.fixLane,.fixReview,.fixCi,.blockedHead,.fixHead,.blockedTitle,.fixTitle] | @tsv'
    return
  fi

  generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  total=$(printf '%s\n' "$rows" | jq 'length')
  ready=$(printf '%s\n' "$rows" | jq '[.[] | select(.handoff == "fix-ready")] | length')
  not_ready=$(printf '%s\n' "$rows" | jq '[.[] | select(.handoff == "fix-not-ready")] | length')

  cat <<EOF_REPORT
# Lumen stacked fix handoff

Generated: $generated_at

| bucket | count |
|---|---:|
| fix-ready | $ready |
| fix-not-ready | $not_ready |
| total handoffs | $total |

## Handoffs

| handoff | blocked PR | blocked state | fix PR | fix state | branch handoff | titles |
|---|---|---|---|---|---|---|
EOF_REPORT
  printf '%s\n' "$rows" | jq -r '.[] | "| " + .handoff + " | [#" + (.blockedNumber|tostring) + "](" + .blockedUrl + ") | " + .blockedLane + " / " + .blockedReview + " / " + .blockedCi + " | [#" + (.fixNumber|tostring) + "](" + .fixUrl + ") | " + .fixLane + " / " + .fixReview + " / " + .fixCi + " | `" + .blockedHead + " <- " + .fixHead + "` | " + (.blockedTitle | gsub("\\|"; "\\|")) + " ⇢ " + (.fixTitle | gsub("\\|"; "\\|")) + " |"'
}

if [ "$JSON_ONLY" = "1" ]; then
  if [ -n "$OUT" ]; then
    write_json > "$OUT"
    printf 'wrote %s\n' "$OUT"
  else
    write_json
  fi
  exit 0
fi

if [ -n "$OUT" ]; then
  {
    write_report
    if [ "$OUTPUT_JSON" = "1" ]; then
      printf '\nJSON payload:\n'
      write_json
    fi
  } > "$OUT"
  printf 'wrote %s\n' "$OUT"
else
  write_report
  if [ "$OUTPUT_JSON" = "1" ]; then
    printf '\nJSON payload:\n'
    write_json
  fi
fi
