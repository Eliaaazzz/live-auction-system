#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy-rehearsal-closure-check.sh --out-dir PATH [options]

Options:
  --out-dir PATH            rehearsal output directory (required)
  --eval-report PATH        explicit load eval report path
  --report PATH             write closure summary to this file
  --second-price-report PATH explicit second-price payment report path
  --allow-fail-reported N   allow remote result=FAIL-REPORTED when N is truthy (1/true/yes/on; default: 1)
  --format FORMAT           output format: tsv|markdown (default: tsv)
  --markdown                alias for --format markdown
  -h, --help               show this help

Summary:
  This helper emits a closure status (PASS / PASS-REPORTED / FAIL) for a rehearsal bundle and checks:
  1) deploy preflight failed_checks==0
  2) remote perf gate result PASS/FAIL-REPORTED
  3) optional load eval summary (if provided/found)
  4) optional second-price payment settlement summary
  5) catchup/ws guard status from manifest.json when available
USAGE
  exit 2
}

normalize_bool01() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$normalized" in
    1|true|yes|on)
      echo 1
      return
      ;;
    0|false|no|off)
      echo 0
      return
      ;;
    *)
      echo "error: --allow-fail-reported must be 0/1/true/false/yes/no/on/off" >&2
      exit 2
      ;;
  esac
}

normalize_format() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$normalized" in
    tsv)
      echo "tsv"
      return
      ;;
    markdown|md)
      echo "markdown"
      return
      ;;
    *)
      echo "error: --format must be tsv or markdown" >&2
      exit 2
      ;;
  esac
}

OUT_DIR="${OUT_DIR:-}"
REPORT_PATH="${REPORT_PATH:-}"
EVAL_REPORT="${EVAL_REPORT:-}"
SECOND_PRICE_REPORT="${SECOND_PRICE_REPORT:-}"
ALLOW_FAIL_REPORTED="${ALLOW_FAIL_REPORTED:-1}"
REPORT_FORMAT="${REPORT_FORMAT:-tsv}"

if [[ $# -eq 0 ]]; then
  usage
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --report)
      REPORT_PATH="$2"
      shift 2
      ;;
    --eval-report)
      EVAL_REPORT="$2"
      shift 2
      ;;
    --second-price-report)
      SECOND_PRICE_REPORT="$2"
      shift 2
      ;;
    --allow-fail-reported)
      ALLOW_FAIL_REPORTED="$2"
      shift 2
      ;;
    --format)
      REPORT_FORMAT="$2"
      shift 2
      ;;
    --markdown)
      REPORT_FORMAT="markdown"
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "error: unknown arg: $1"
      usage
      ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  echo "error: --out-dir is required"
  exit 2
fi

if [[ ! -d "$OUT_DIR" ]]; then
  echo "error: rehearsal output dir not found: $OUT_DIR"
  exit 2
fi

REPORT_FORMAT="$(normalize_format "$REPORT_FORMAT")"
ALLOW_FAIL_REPORTED="$(normalize_bool01 "$ALLOW_FAIL_REPORTED")"

record() {
  local artifact="$1"
  local status="$2"
  local reason="$3"
  local path="$4"

  ARTIFACTS+=("$artifact")
  STATUSES+=("$status")
  REASONS+=("$reason")
  PATHS+=("$path")
}

overall="PASS"
declare -a ARTIFACTS
declare -a STATUSES
declare -a REASONS
declare -a PATHS

manifest_file=""
if [[ -f "$OUT_DIR/manifest.json" ]]; then
  manifest_file="$OUT_DIR/manifest.json"
elif [[ -f "$OUT_DIR"/manifest.json ]]; then
  manifest_file="$OUT_DIR"/manifest.json
fi

status_file=""
if [[ -f "$OUT_DIR/status.tsv" ]]; then
  status_file="$OUT_DIR/status.tsv"
fi

# 1) preflight: PASS if failed_checks == 0 or status.tsv has no rc!=0 rows.
preflight_status="PASS"
preflight_reason="ok"
if [[ -f "$OUT_DIR/manifest.txt" ]]; then
  preflight_failed="$(awk -F= '/^failed_checks=/{print $2}' "$OUT_DIR/manifest.txt" | tr -dc '0-9' | head -n1 || true)"
  if [[ -n "$preflight_failed" ]] && [[ "$preflight_failed" -gt 0 ]]; then
    preflight_status="FAIL"
    preflight_reason="manifest failed_checks=$preflight_failed"
    overall="FAIL"
  fi
elif [[ -n "$status_file" ]]; then
  preflight_failed_rc="$(awk -F'\t' 'NR>1 {if ($2 != "0") {bad=1; exit}} END {print (bad ? 1 : 0)}' "$status_file" 2>/dev/null || true)"
  if [[ "$preflight_failed_rc" == "1" ]]; then
    preflight_status="FAIL"
    preflight_reason="status.tsv contains failed check rows"
    overall="FAIL"
  fi
else
  preflight_status="FAIL"
  preflight_reason="missing manifest.txt and status.tsv"
  overall="FAIL"
fi
record "deploy_preflight" "$preflight_status" "$preflight_reason" "${OUT_DIR}"

# 2) remote perf gate
perf_summary=""
perf_gate_dir=""
if [[ -f "$OUT_DIR/perf-gate/summary.md" ]]; then
  perf_summary="$OUT_DIR/perf-gate/summary.md"
  perf_gate_dir="$OUT_DIR/perf-gate"
else
  while IFS= read -r candidate; do
    if [[ "$candidate" == *"/perf-gate/summary.md" ]]; then
      perf_summary="$candidate"
      perf_gate_dir="$(dirname "$perf_summary")"
      break
    fi
  done < <(find "$OUT_DIR" -type f -name 'summary.md' 2>/dev/null | sort)
fi

if [[ -z "$perf_summary" ]]; then
  perf_status="FAIL"
  perf_reason="missing perf gate summary.md"
  overall="FAIL"
  perf_client_status="FAIL"
  perf_client_reason="missing perf gate summary.md"
  perf_client_path="-"
elif [[ ! -r "$perf_summary" ]]; then
  perf_status="FAIL"
  perf_reason="perf summary unreadable"
  overall="FAIL"
  perf_client_status="FAIL"
  perf_client_reason="perf summary unreadable"
  perf_client_path="-"
else
  perf_gate_dir="$(dirname "$perf_summary")"
  perf_result="$(awk -F': ' '/^-[[:space:]]*result:/{print $2; exit}' "$perf_summary" | tr -d '\r\n ')"
  if [[ -z "$perf_result" ]]; then
    perf_result="$(awk -F'=' '/^result=/{print $2; exit}' "$perf_summary" | tr -d '\r\n ')"
  fi
    case "$perf_result" in
    PASS)
      perf_status="PASS"
      perf_reason="result=$perf_result"
      ;;
    FAIL-REPORTED)
      if [[ "${ALLOW_FAIL_REPORTED}" == "1" ]]; then
        perf_status="PASS-REPORTED"
        perf_reason="result=$perf_result"
        if [[ "$overall" != "FAIL" ]]; then
          overall="PASS-REPORTED"
        fi
      else
        perf_status="FAIL"
        perf_reason="result=$perf_result"
        overall="FAIL"
      fi
      ;;
    "")
      perf_status="FAIL"
      perf_reason="perf summary missing result"
      overall="FAIL"
      ;;
    *)
      perf_status="FAIL"
      perf_reason="result=$perf_result"
      overall="FAIL"
      ;;
  esac

  client_observed_rel="$(awk -F': ' '/^-[[:space:]]*client_observed:/{print $2; exit}' "$perf_summary" | tr -d '\r\n ' )"
  if [[ -n "$client_observed_rel" ]]; then
    if [[ "$client_observed_rel" = /* ]]; then
      client_observed_path="$client_observed_rel"
    else
      client_observed_path="$perf_gate_dir/$client_observed_rel"
    fi
    if [[ -r "$client_observed_path" ]]; then
      perf_client_status="PASS"
      perf_client_reason="present: $(printf '%s' "$client_observed_rel")"
    else
      perf_client_status="FAIL"
      perf_client_reason="client_observed path not readable: $client_observed_path"
      if [[ "$overall" != "FAIL" ]]; then
        overall="FAIL"
      fi
    fi
  else
    explicit_client_observed="${PERF_GATE_CLIENT_SUMMARY:-}"
    if [[ -n "$explicit_client_observed" ]] && [[ -r "$explicit_client_observed" ]]; then
      perf_client_status="PASS"
      perf_client_reason="present: explicit PERF_GATE_CLIENT_SUMMARY"
      client_observed_path="$explicit_client_observed"
    elif [[ -n "$explicit_client_observed" ]]; then
      perf_client_status="FAIL"
      perf_client_reason="explicit PERF_GATE_CLIENT_SUMMARY not readable: $explicit_client_observed"
      client_observed_path="$explicit_client_observed"
      if [[ "$overall" != "FAIL" ]]; then
        overall="FAIL"
      fi
    else
      perf_client_status="SKIP"
      perf_client_reason="client observed metrics not requested"
      client_observed_path="-"
    fi
  fi
fi
record "remote_perf_gate" "$perf_status" "$perf_reason" "${perf_summary:-$OUT_DIR}"
record "remote_perf_client_observed" "$perf_client_status" "$perf_client_reason" "${client_observed_path:-$OUT_DIR}"

# 3) optional load eval
if [[ -z "$EVAL_REPORT" ]] && [[ -f "$OUT_DIR/eval-load-100k-rehearsal-summary.tsv" ]]; then
  EVAL_REPORT="$OUT_DIR/eval-load-100k-rehearsal-summary.tsv"
fi
if [[ -z "$EVAL_REPORT" ]]; then
  while IFS= read -r candidate; do
    EVAL_REPORT="$candidate"
    break
  done < <(find "$OUT_DIR" -type f -name 'eval-load-100k-rehearsal-summary.tsv' 2>/dev/null | sort)
fi

if [[ -z "$EVAL_REPORT" ]]; then
  load_eval_status="SKIP"
  load_eval_reason="no eval-load-100k-rehearsal-summary.tsv"
elif [[ ! -r "$EVAL_REPORT" ]]; then
  load_eval_status="FAIL"
  load_eval_reason="cannot read eval report"
  overall="FAIL"
else
  load_eval_result="$(awk -F'=' '/^result=/{print $2; exit}' "$EVAL_REPORT" | tr -d '\r\n ')"
  if [[ "$load_eval_result" == "PASS" ]]; then
    load_eval_status="PASS"
    load_eval_reason="result=PASS"
  elif [[ "$load_eval_result" == "PASS-REPORTED" ]]; then
    load_eval_status="PASS-REPORTED"
    load_eval_reason="result=PASS-REPORTED"
    if [[ "$overall" != "FAIL" ]]; then
      overall="PASS-REPORTED"
    fi
  elif [[ "$load_eval_result" == "" ]]; then
    load_eval_status="FAIL"
    load_eval_reason="missing result line"
    overall="FAIL"
  else
    load_eval_status="FAIL"
    load_eval_reason="result=$load_eval_result"
    overall="FAIL"
  fi
fi
record "load_eval" "$load_eval_status" "$load_eval_reason" "${EVAL_REPORT:--}"

# 3.5) optional second-price settlement check
if [[ -z "$SECOND_PRICE_REPORT" ]]; then
  if [[ -f "$OUT_DIR/verify-second-price-payment-summary.tsv" ]]; then
    SECOND_PRICE_REPORT="$OUT_DIR/verify-second-price-payment-summary.tsv"
  else
    while IFS= read -r candidate; do
      if [[ -n "$candidate" ]]; then
        SECOND_PRICE_REPORT="$candidate"
        break
      fi
    done < <(find "$OUT_DIR" -type f -name 'verify-second-price-payment-summary.tsv' 2>/dev/null | sort)
  fi
fi

if [[ -z "$SECOND_PRICE_REPORT" ]]; then
  second_price_status="SKIP"
  second_price_reason="no verify-second-price-payment-summary.tsv"
elif [[ ! -r "$SECOND_PRICE_REPORT" ]]; then
  second_price_status="FAIL"
  second_price_reason="cannot read second-price payment report"
  overall="FAIL"
else
  second_price_result="$(sed -n 's/^result=\([A-Za-z-][A-Za-z-]*\).*/\1/p' "$SECOND_PRICE_REPORT" | head -n1 | tr -d '\r\n ')"
  if [[ "$second_price_result" == "PASS" ]]; then
    second_price_status="PASS"
    second_price_reason="result=PASS"
  elif [[ "$second_price_result" == "" ]]; then
    second_price_status="FAIL"
    second_price_reason="missing result line"
    overall="FAIL"
  else
    second_price_status="FAIL"
    second_price_reason="result=$second_price_result"
    overall="FAIL"
  fi
fi
record "second_price_payment" "$second_price_status" "$second_price_reason" "${SECOND_PRICE_REPORT:--}"

# 4) optional replay/consistency checks from manifest.json
catchup_status="SKIP"
catchup_reason="manifest.json not present"
ws_status="SKIP"
ws_reason="manifest.json not present"
if [[ -n "$manifest_file" ]]; then
  if command -v jq >/dev/null 2>&1; then
    catchup_enabled="$(jq -r '.catchup_checks.enabled // false' "$manifest_file" 2>/dev/null || true)"
    catchup_failed="$(jq -r '.catchup_checks.failed // 0' "$manifest_file" 2>/dev/null || true)"
    catchup_passed="$(jq -r '.catchup_checks.pass // 0' "$manifest_file" 2>/dev/null || true)"
    ws_enabled="$(jq -r '.ws_precheck_checks.enabled // false' "$manifest_file" 2>/dev/null || true)"
    ws_failed="$(jq -r '.ws_precheck_checks.failed // 0' "$manifest_file" 2>/dev/null || true)"
    ws_passed="$(jq -r '.ws_precheck_checks.pass // 0' "$manifest_file" 2>/dev/null || true)"

    if [[ "$catchup_enabled" == "true" ]]; then
      if [[ "${catchup_failed:-0}" -gt 0 ]]; then
        catchup_status="FAIL"
        catchup_reason="catchup failed=$catchup_failed"
        overall="FAIL"
      else
        catchup_status="PASS"
        catchup_reason="catchup pass=$catchup_passed failed=$catchup_failed"
      fi
    else
      catchup_status="SKIP"
      catchup_reason="catchup_checks.enabled=false"
    fi

    if [[ "$ws_enabled" == "true" ]]; then
      if [[ "${ws_failed:-0}" -gt 0 ]]; then
        ws_status="FAIL"
        ws_reason="ws_precheck failed=$ws_failed"
        overall="FAIL"
      else
        ws_status="PASS"
        ws_reason="ws_precheck pass=$ws_passed failed=$ws_failed"
      fi
    else
      ws_status="SKIP"
      ws_reason="ws_precheck_checks.enabled=false"
    fi
  else
    catchup_reason="jq missing"
    ws_reason="jq missing"
  fi
else
  catchup_reason="manifest.json not present"
  ws_reason="manifest.json not present"
fi
record "catchup_checks" "$catchup_status" "$catchup_reason" "${manifest_file:-$OUT_DIR}"
record "ws_precheck" "$ws_status" "$ws_reason" "${manifest_file:-$OUT_DIR}"

# final
overall_status="$overall"

emit_report_tsv() {
  printf "artifact\tstatus\treason\tpath\n"
  for i in "${!ARTIFACTS[@]}"; do
    printf "%s\t%s\t%s\t%s\n" "${ARTIFACTS[$i]}" "${STATUSES[$i]}" "${REASONS[$i]}" "${PATHS[$i]}"
  done
  printf "overall\t%s\tfinal\t%s\n" "$overall_status" "$OUT_DIR"
}

escape_md_field() {
  printf '%s' "$1" | sed 's/|/\\|/g'
}

emit_report_markdown() {
  printf "## Deployment rehearsal closure check\n\n"
  printf "| artifact | status | reason | path |\n"
  printf "| --- | --- | --- | --- |\n"
  for i in "${!ARTIFACTS[@]}"; do
    printf "| %s | %s | %s | %s |\n" \
      "$(escape_md_field "${ARTIFACTS[$i]}")" \
      "$(escape_md_field "${STATUSES[$i]}")" \
      "$(escape_md_field "${REASONS[$i]}")" \
      "$(escape_md_field "${PATHS[$i]}")"
  done
  printf "| overall | %s | final | %s |\n" \
    "$(escape_md_field "$overall_status")" \
    "$(escape_md_field "$OUT_DIR")"
}

emit_report() {
  local format="$1"
  case "$format" in
    tsv)
      emit_report_tsv
      ;;
    markdown)
      emit_report_markdown
      ;;
    *)
      echo "error: unsupported report format: $format" >&2
      exit 2
      ;;
  esac
}

emit_report "$REPORT_FORMAT"

if [[ -n "$REPORT_PATH" ]]; then
  report_dir="$(dirname "$REPORT_PATH")"
  if ! mkdir -p "$report_dir"; then
    echo "error: unable to create report dir: $report_dir"
    exit 2
  fi
  {
    emit_report "$REPORT_FORMAT"
  } > "$REPORT_PATH"
  echo "closure report: $REPORT_PATH"
fi

if [[ "$overall" == "FAIL" ]]; then
  exit 1
fi
