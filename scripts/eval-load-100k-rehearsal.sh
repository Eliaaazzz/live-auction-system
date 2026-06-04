#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/eval-load-100k-rehearsal.sh --pack-dir PATH [options]

Environment:
  MAX_OBSERVER_READ_ERRORS   max allowed observer readErrors in summary checks (default: 0)
  MAX_OBSERVER_DIAL_ERRORS   max allowed observer dialErrors in summary checks (default: 0)
  MAX_SEQ_GAP                max allowed seqGapCount in summary checks (default: 0)
  MAX_BACKPRESSURE           max allowed backpressureForceClose in summary checks (default: 0)
  REQUIRE_CATCHUP            force catchup checks as required when summary was run with --catchup-smoke (default: auto)
  REQUIRE_WS_PRECHECK        force ws-precheck checks as required when summary was run with --ws-precheck (default: auto)

Options:
  --pack-dir PATH            rehearsal output root (required)
  --summary PATH             override summary.tsv path (default: <pack-dir>/summary.tsv)
  --manifest PATH            override manifest.json path (default: <pack-dir>/manifest.json)
  --max-observer-read-errors N
  --max-observer-dial-errors N
  --max-seq-gap N
  --max-backpressure N
  --min-bid-sent N          minimum allowed bidder.sent per run (default: 1)
  --min-bid-acked N         minimum allowed bidder.acked per run (default: 1)
  --require-catchup
  --no-require-catchup
  --require-ws-precheck
  --no-require-ws-precheck
  --report PATH             write evaluation summary to path (default: unset)
  -h, --help                show this help

Notes:
  By default REQUIRE_* are resolved from manifest fields `catchup_checks.enabled`
  and `ws_precheck_checks.enabled`; if manifest is missing, both default to 0.
USAGE
}

is_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

die() {
  echo "error: $*" >&2
  exit 2
}

is_true() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_false() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)" in
    0|false|no|off)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

as_bool01() {
  if is_true "$1"; then
    echo 1
    return
  fi
  if is_false "$1"; then
    echo 0
    return
  fi
  die "invalid boolean value '$1'; expected 0/1/true/false/yes/no/on/off"
}

MAX_OBSERVER_READ_ERRORS="${MAX_OBSERVER_READ_ERRORS:-0}"
MAX_OBSERVER_DIAL_ERRORS="${MAX_OBSERVER_DIAL_ERRORS:-0}"
MAX_SEQ_GAP="${MAX_SEQ_GAP:-0}"
MAX_BACKPRESSURE="${MAX_BACKPRESSURE:-0}"
MIN_BID_SENT="${MIN_BID_SENT:-1}"
MIN_BID_ACKED="${MIN_BID_ACKED:-1}"
REQUIRE_CATCHUP="${REQUIRE_CATCHUP:-auto}"
REQUIRE_WS_PRECHECK="${REQUIRE_WS_PRECHECK:-auto}"
REPORT_PATH="${REPORT_PATH:-}"

PACK_DIR=""
SUMMARY_PATH=""
MANIFEST_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pack-dir)
      PACK_DIR="$2"
      shift 2
      ;;
    --summary)
      SUMMARY_PATH="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="$2"
      shift 2
      ;;
    --report)
      REPORT_PATH="$2"
      shift 2
      ;;
    --max-observer-read-errors)
      MAX_OBSERVER_READ_ERRORS="$2"
      shift 2
      ;;
    --max-observer-dial-errors)
      MAX_OBSERVER_DIAL_ERRORS="$2"
      shift 2
      ;;
    --max-seq-gap)
      MAX_SEQ_GAP="$2"
      shift 2
      ;;
    --max-backpressure)
      MAX_BACKPRESSURE="$2"
      shift 2
      ;;
    --min-bid-sent)
      MIN_BID_SENT="$2"
      shift 2
      ;;
    --min-bid-acked)
      MIN_BID_ACKED="$2"
      shift 2
      ;;
    --require-catchup)
      REQUIRE_CATCHUP="1"
      shift
      ;;
    --no-require-catchup)
      REQUIRE_CATCHUP="0"
      shift
      ;;
    --require-ws-precheck)
      REQUIRE_WS_PRECHECK="1"
      shift
      ;;
    --no-require-ws-precheck)
      REQUIRE_WS_PRECHECK="0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1"
      usage
      exit 2
      ;;
  esac

done

REQUIRE_CATCHUP="$(printf '%s' "$REQUIRE_CATCHUP" | tr '[:upper:]' '[:lower:]' | xargs)"
REQUIRE_WS_PRECHECK="$(printf '%s' "$REQUIRE_WS_PRECHECK" | tr '[:upper:]' '[:lower:]' | xargs)"

if [[ -z "$PACK_DIR" ]]; then
  echo "error: --pack-dir is required"
  usage
  exit 2
fi

if ! is_non_negative_int "$MAX_OBSERVER_READ_ERRORS"; then
  echo "error: --max-observer-read-errors must be a non-negative integer"
  exit 2
fi

if ! is_non_negative_int "$MAX_OBSERVER_DIAL_ERRORS"; then
  echo "error: --max-observer-dial-errors must be a non-negative integer"
  exit 2
fi

if ! is_non_negative_int "$MAX_SEQ_GAP"; then
  echo "error: --max-seq-gap must be a non-negative integer"
  exit 2
fi

if ! is_non_negative_int "$MAX_BACKPRESSURE"; then
  echo "error: --max-backpressure must be a non-negative integer"
  exit 2
fi
if ! is_non_negative_int "$MIN_BID_SENT"; then
  echo "error: --min-bid-sent must be a non-negative integer"
  exit 2
fi
if ! is_non_negative_int "$MIN_BID_ACKED"; then
  echo "error: --min-bid-acked must be a non-negative integer"
  exit 2
fi

case "$REQUIRE_CATCHUP" in
  auto)
    ;;
  *)
    if ! is_true "$REQUIRE_CATCHUP" && ! is_false "$REQUIRE_CATCHUP"; then
      echo "error: REQUIRE_CATCHUP must be one of auto, true/false, yes/no, on/off, 1/0"
      exit 2
    fi
    ;;
esac

case "$REQUIRE_WS_PRECHECK" in
  auto)
    ;;
  *)
    if ! is_true "$REQUIRE_WS_PRECHECK" && ! is_false "$REQUIRE_WS_PRECHECK"; then
      echo "error: REQUIRE_WS_PRECHECK must be one of auto, true/false, yes/no, on/off, 1/0"
      exit 2
    fi
    ;;
esac

if [[ ! -d "$PACK_DIR" ]]; then
  echo "error: pack dir not found: $PACK_DIR"
  exit 2
fi

SUMMARY_PATH="${SUMMARY_PATH:-$PACK_DIR/summary.tsv}"
MANIFEST_PATH="${MANIFEST_PATH:-$PACK_DIR/manifest.json}"

if [[ ! -r "$SUMMARY_PATH" ]]; then
  echo "error: summary file not readable: $SUMMARY_PATH"
  exit 2
fi

if [[ -z "$REQUIRE_CATCHUP" || "$REQUIRE_CATCHUP" == "auto" ]]; then
  if command -v jq >/dev/null 2>&1 && [[ -r "$MANIFEST_PATH" ]]; then
    catchup_enabled=$(jq -r '.catchup_checks.enabled // false' "$MANIFEST_PATH")
    if [[ "$catchup_enabled" == "true" ]]; then
      REQUIRE_CATCHUP="1"
    else
      REQUIRE_CATCHUP="0"
    fi
  else
    REQUIRE_CATCHUP="0"
  fi
fi

if [[ -z "$REQUIRE_WS_PRECHECK" || "$REQUIRE_WS_PRECHECK" == "auto" ]]; then
  if command -v jq >/dev/null 2>&1 && [[ -r "$MANIFEST_PATH" ]]; then
    ws_precheck_enabled=$(jq -r '.ws_precheck_checks.enabled // false' "$MANIFEST_PATH")
    if [[ "$ws_precheck_enabled" == "true" ]]; then
      REQUIRE_WS_PRECHECK="1"
    else
      REQUIRE_WS_PRECHECK="0"
    fi
  else
    REQUIRE_WS_PRECHECK="0"
  fi
fi

REQUIRE_CATCHUP="$(as_bool01 "$REQUIRE_CATCHUP")"
REQUIRE_WS_PRECHECK="$(as_bool01 "$REQUIRE_WS_PRECHECK")"

if ! command -v awk >/dev/null 2>&1; then
  echo "error: awk is required"
  exit 2
fi

set +e
eval_output=$(awk -F '\t' \
  -v pack="$PACK_DIR" \
  -v max_read="$MAX_OBSERVER_READ_ERRORS" \
  -v max_dial="$MAX_OBSERVER_DIAL_ERRORS" \
  -v max_seq="$MAX_SEQ_GAP" \
  -v max_back="$MAX_BACKPRESSURE" \
  -v min_bid_sent="$MIN_BID_SENT" \
  -v min_bid_acked="$MIN_BID_ACKED" \
  -v req_catchup="$REQUIRE_CATCHUP" \
  -v req_ws="$REQUIRE_WS_PRECHECK" '
function col(name, alt,   i) {
  i = h[name]
  if (i == "" && alt != "") {
    i = h[alt]
  }
  if (i == "") return ""
  return $i
}

NR==1 {
  for (i = 1; i <= NF; i++) {
    h[$i] = i
  }
  required_cols = "status run_dir log_file metrics_file observer_read_errors observer_dial_errors seq_gap_count backpressure_force_close bidder_sent bidder_acked"
  required_count = split(required_cols, required, " ")
  for (i = 1; i <= required_count; i++) {
    if (!(required[i] in h)) {
      printf "error: summary missing required column: %s\n", required[i]
      exit 2
    }
  }
  optional_cols = "catchup_status ws_precheck_status"
  optional_count = split(optional_cols, optional, " ")
  catchup_status_present = 0
  ws_status_present = 0
  for (i = 1; i <= optional_count; i++) {
    if (optional[i] == "catchup_status" && (optional[i] in h)) {
      catchup_status_present = 1
    }
    if (optional[i] == "ws_precheck_status" && (optional[i] in h)) {
      ws_status_present = 1
    }
  }
  run_col = "#run"
  if (!(run_col in h)) {
    run_col = "run"
  }
  if (!(run_col in h)) {
    printf "error: summary missing required column: run or #run\n"
    exit 2
  }
  next
}
{
  total += 1
  run_raw = col(run_col, "")
  status = col("status", "")
  run_dir = col("run_dir", "")
  log_file = col("log_file", "")
  metrics_file = col("metrics_file", "")
  observer_read_errors = col("observer_read_errors", "") + 0
  observer_dial_errors = col("observer_dial_errors", "") + 0
  seq_gap_count = col("seq_gap_count", "") + 0
  backpressure_force_close = col("backpressure_force_close", "") + 0
  bidder_sent = col("bidder_sent", "bid_sent") + 0
  bidder_acked = col("bidder_acked", "bid_acked") + 0
  catchup_status = col("catchup_status", "")
  ws_status = col("ws_precheck_status", "")

  if (run_raw == "") {
    ok = 0
    reasons = "missing run index"
  } else {
    run = run_raw + 0
    ok = 1
    reasons = ""
  }

  total_read += observer_read_errors
  total_dial += observer_dial_errors
  total_seq += seq_gap_count
  total_back += backpressure_force_close
  total_bid_sent += bidder_sent
  total_bid_acked += bidder_acked

  if (status != "PASS") {
    ok = 0
    reasons = reasons "load_status=" status
  }
  if (observer_read_errors > max_read) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "observer_read_errors=" observer_read_errors
  }
  if (observer_dial_errors > max_dial) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "observer_dial_errors=" observer_dial_errors
  }
  if (seq_gap_count > max_seq) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "seq_gap_count=" seq_gap_count
  }
  if (backpressure_force_close > max_back) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "backpressure_force_close=" backpressure_force_close
  }
  if (bidder_sent < min_bid_sent) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "bidder_sent<" min_bid_sent
  }
  if (bidder_acked < min_bid_acked) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "bidder_acked<" min_bid_acked
  }
  if (req_catchup == "1" && !catchup_status_present) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "catchup_status column missing"
  } else if (req_catchup == "1" && catchup_status != "PASS" && catchup_status != "SKIP" && catchup_status != "SKIP_NO_AUCTION" && catchup_status != "SKIP_DISABLED") {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "catchup_status=" catchup_status
  }
  if (req_ws == "1" && !ws_status_present) {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "ws_precheck_status column missing"
  } else if (req_ws == "1" && ws_status != "PASS" && ws_status != "SKIP" && ws_status != "SKIP_NO_AUCTION" && ws_status != "SKIP_DISABLED") {
    ok = 0
    reasons = reasons (length(reasons) ? "; " : "") "ws_precheck_status=" ws_status
  }

  if (ok) {
    pass += 1
  } else {
    fail += 1
    has_issue = 1
    printf "run=%d FAIL  reasons: %s\nrun_dir=%s\nlog=%s\nmetrics=%s\n\n", run, reasons, run_dir, log_file, metrics_file
  }
}
END {
  if (total == 0) {
    print "error: summary.tsv is empty"
    exit 2
  }

  printf "rehearsal_pack=%s\n", pack
  printf "rows=%d\tpass=%d\tfail=%d\n", total, pass, fail
  printf "totals\tobserver_read_errors=%d\tobserver_dial_errors=%d\tseq_gap_count=%d\tbackpressure_force_close=%d\n", total_read, total_dial, total_seq, total_back
  printf "totals\tbidder_sent=%d\tbidder_acked=%d\n", total_bid_sent, total_bid_acked
  if (has_issue) {
    print "result=FAIL"
    exit 1
  }
  print "result=PASS"
}
' "$SUMMARY_PATH")
awk_rc=$?
set -e

if [[ $awk_rc -gt 1 ]]; then
  echo "error: failed to parse $SUMMARY_PATH"
  exit 2
fi

echo "$eval_output"

if ! echo "$eval_output" | grep -q '^result='; then
  echo "error: summary evaluation result missing"
  exit 2
fi

if [[ -n "$REPORT_PATH" ]]; then
  report_dir="$(dirname "$REPORT_PATH")"
  if ! mkdir -p "$report_dir"; then
    echo "error: failed to create report directory: $report_dir"
    exit 2
  fi
  if ! printf '%s\n' "$eval_output" > "$REPORT_PATH"; then
    echo "error: failed to write report: $REPORT_PATH"
    exit 2
  fi
  echo "evaluation report: $REPORT_PATH"
fi

if echo "$eval_output" | grep -q '^result=FAIL$'; then
  exit 1
fi
