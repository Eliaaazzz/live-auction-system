#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/runner-up-pays-fixtures-check.sh [docs/runner-up-pays-fixtures.json]

Purpose:
  Offline verifier for the RUNNER_UP_PAYS design fixtures. This does not execute
  runtime code. It checks that the fixture contract stays aligned with the
  post-foundation mode guardrails: virtual coins only, no normal fiat orders,
  one rank per bidder, capped runner-up liability, and no liability when there
  is no distinct runner-up.
USAGE
}

fixture="${1:-docs/runner-up-pays-fixtures.json}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$fixture" ]]; then
  echo "fixture not found: $fixture" >&2
  usage >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

errors="$(
  jq -r '
    def cents_ok:
      type == "string" and test("^(0|[1-9][0-9]*)$");
    def cents_key($s):
      [$s | length, $s];
    def cents_lte($a; $b):
      cents_key($a) <= cents_key($b);
    def cents_min($a; $b):
      if cents_lte($a; $b) then $a else $b end;
    def err($case; $msg):
      "\($case): \($msg)";
    def top_bids:
      (.acceptedBids // [])
      | group_by(.userId)
      | map(max_by(cents_key(.amountCents)))
      | sort_by(cents_key(.amountCents), .seq)
      | reverse;
    def root_errors:
      [
        if .mode == "RUNNER_UP_PAYS" then empty else "root: mode must be RUNNER_UP_PAYS" end,
        if (.modeVersion | type) == "string" and (.modeVersion | length) > 0 then empty else "root: modeVersion must be a non-empty string" end,
        if .schemaVersion == 1 then empty else "root: schemaVersion must be 1" end,
        if .settlementType == "VIRTUAL_COINS_ONLY" then empty else "root: settlementType must be VIRTUAL_COINS_ONLY" end,
        if .normalFiatOrdersAllowed == false then empty else "root: normalFiatOrdersAllowed must be false" end,
        if (.liabilityCapCents | cents_ok) then empty else "root: liabilityCapCents must be a canonical cents string" end,
        if .rules.winnerRunnerUpDistinct == true then empty else "root: winnerRunnerUpDistinct must be true" end,
        if (.cases | type) == "array" and (.cases | length) >= 5 then empty else "root: expected at least five settlement cases" end
      ];
    def case_errors($cap):
      . as $c
      | ($c.name // "<unnamed>") as $name
      | ($c.expected // {}) as $e
      | ($c | top_bids) as $top
      | ($top[0] // null) as $winner
      | ($top[1] // null) as $runner
      | (if $winner == null then null else $winner.userId end) as $wantWinnerId
      | (if $winner == null then "0" else $winner.amountCents end) as $wantWinnerBid
      | (if $runner == null then null else $runner.userId end) as $wantRunnerId
      | (if $runner == null then "0" else $runner.amountCents end) as $wantRunnerBid
      | (if $runner == null then "0" else cents_min($runner.amountCents; $cap) end) as $wantLiability
      | (if ($top | length) == 0 then "AUCTION_NO_BID" else "AUCTION_SOLD" end) as $wantTerminal
      | ($runner != null) as $wantEmitSettled
      | [
          if ($c.name | type) == "string" and ($c.name | length) > 0 then empty else err($name; "name must be a non-empty string") end,
          if ($c.acceptedBids | type) == "array" then empty else err($name; "acceptedBids must be an array") end,
          ($c.acceptedBids[]? | select((.seq | type) != "number" or (.userId | type) != "string" or (.amountCents | cents_ok | not)) | err($name; "acceptedBids entries must include numeric seq, string userId, canonical amountCents")),
          if $e.normalFiatOrders == 0 then empty else err($name; "normalFiatOrders must stay 0") end,
          if $e.terminalEvent == $wantTerminal then empty else err($name; "terminalEvent expected \($wantTerminal), got \($e.terminalEvent)") end,
          if $e.winnerId == $wantWinnerId then empty else err($name; "winnerId expected \($wantWinnerId), got \($e.winnerId)") end,
          if $e.winnerBidCents == $wantWinnerBid then empty else err($name; "winnerBidCents expected \($wantWinnerBid), got \($e.winnerBidCents)") end,
          if $e.runnerUpId == $wantRunnerId then empty else err($name; "runnerUpId expected \($wantRunnerId), got \($e.runnerUpId)") end,
          if $e.runnerUpBidCents == $wantRunnerBid then empty else err($name; "runnerUpBidCents expected \($wantRunnerBid), got \($e.runnerUpBidCents)") end,
          if $e.runnerUpLiabilityCents == $wantLiability then empty else err($name; "runnerUpLiabilityCents expected \($wantLiability), got \($e.runnerUpLiabilityCents)") end,
          if $e.emitRunnerUpSettled == $wantEmitSettled then empty else err($name; "emitRunnerUpSettled expected \($wantEmitSettled), got \($e.emitRunnerUpSettled)") end,
          if ($e.winnerId == null or $e.runnerUpId == null or $e.winnerId != $e.runnerUpId) then empty else err($name; "winnerId and runnerUpId must be distinct") end,
          if (($e.runnerUpId == null and $e.runnerUpLiabilityCents == "0") or ($e.runnerUpId != null)) then empty else err($name; "missing runner-up must have zero liability") end
        ];
    . as $root
    | (
        root_errors
        + (
          ($root.liabilityCapCents // "0") as $cap
          | ($root.cases // [])
          | map(case_errors($cap))
          | add
        )
      )
    | .[]
  ' "$fixture"
)"

if [[ -n "$errors" ]]; then
  echo "runner-up-pays fixture check failed:" >&2
  printf '%s\n' "$errors" >&2
  exit 1
fi

echo "runner-up-pays fixtures OK: $fixture"
