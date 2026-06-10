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
  --require-second-price-report [auto|1/true/0/false|yes/no|on/off] require second-price report (auto: infer from manifest auction mode, default: auto)
  --allow-fail-reported N   allow remote result=FAIL-REPORTED when N is truthy (1/true/yes/on; default: 1)
  --format FORMAT           output format: tsv|markdown (default: tsv)
  --markdown                alias for --format markdown
  --max-ws-auth-unauthorized N    require ws_auth_unauthorized <= N
  --max-ws-schema-mismatch N      require ws_schema_mismatch <= N
  --max-ws-upgrade-failed N       require ws_upgrade_failed <= N
  -h, --help               show this help

Summary:
  This helper emits a closure status (PASS / PASS-REPORTED / FAIL) for a rehearsal bundle and checks:
  1) deploy preflight failed_checks==0
  2) optional build revision alignment when expected revision is recorded in manifest.txt
  3) remote perf gate result PASS/FAIL-REPORTED
  4) optional load eval summary (if provided/found)
  5) optional second-price payment settlement summary
  6) catchup/ws guard status from manifest.json when available
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

normalize_auction_mode() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]//g')"
  case "$normalized" in
    vickrey|secondprice|second|auction2|2)
      echo "second_price"
      return
      ;;
    firstprice|first|english|auction1|1|en|e)
      echo "first_price"
      return
      ;;
    unknown)
      echo "unknown"
      return
      ;;
    *)
      echo "$normalized"
      return
      ;;
  esac
}

OUT_DIR="${OUT_DIR:-}"
REPORT_PATH="${REPORT_PATH:-}"
EVAL_REPORT="${EVAL_REPORT:-}"
SECOND_PRICE_REPORT="${SECOND_PRICE_REPORT:-}"
SECOND_PRICE_MODE="${SECOND_PRICE_MODE:-auto}"
ALLOW_FAIL_REPORTED="${ALLOW_FAIL_REPORTED:-1}"
REPORT_FORMAT="${REPORT_FORMAT:-tsv}"
MAX_WS_AUTH_UNAUTHORIZED="${MAX_WS_AUTH_UNAUTHORIZED:-0}"
MAX_WS_SCHEMA_MISMATCH="${MAX_WS_SCHEMA_MISMATCH:-0}"
MAX_WS_UPGRADE_FAILED="${MAX_WS_UPGRADE_FAILED:-0}"

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
    --require-second-price-report)
      SECOND_PRICE_MODE="$2"
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
    --max-ws-auth-unauthorized)
      MAX_WS_AUTH_UNAUTHORIZED="$2"
      shift 2
      ;;
    --max-ws-schema-mismatch)
      MAX_WS_SCHEMA_MISMATCH="$2"
      shift 2
      ;;
    --max-ws-upgrade-failed)
      MAX_WS_UPGRADE_FAILED="$2"
      shift 2
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
normalize_bool01_any() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$normalized" in
    1|true|yes|on)
      echo 1
      return
      ;;
    0|false|no|off)
      if [[ "$1" == "auto" ]]; then
        echo auto
      else
        echo 0
      fi
      return
      ;;
    auto)
      echo auto
      return
      ;;
    *)
      echo "error: --require-second-price-report must be auto/1/0/true/false/yes/no/on/off" >&2
      exit 2
      ;;
  esac
}

ALLOW_FAIL_REPORTED="$(normalize_bool01 "$ALLOW_FAIL_REPORTED")"
SECOND_PRICE_MODE="$(normalize_bool01_any "$SECOND_PRICE_MODE")"

if ! [[ "$MAX_WS_AUTH_UNAUTHORIZED" =~ ^[0-9]+$ ]]; then
  echo "error: --max-ws-auth-unauthorized must be a non-negative integer"
  exit 2
fi
if ! [[ "$MAX_WS_SCHEMA_MISMATCH" =~ ^[0-9]+$ ]]; then
  echo "error: --max-ws-schema-mismatch must be a non-negative integer"
  exit 2
fi
if ! [[ "$MAX_WS_UPGRADE_FAILED" =~ ^[0-9]+$ ]]; then
  echo "error: --max-ws-upgrade-failed must be a non-negative integer"
  exit 2
fi

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

manifest_txt_file=""
if [[ -f "$OUT_DIR/manifest.txt" ]]; then
  manifest_txt_file="$OUT_DIR/manifest.txt"
fi

status_file=""
if [[ -f "$OUT_DIR/status.tsv" ]]; then
  status_file="$OUT_DIR/status.tsv"
fi

manifest_auction_mode=""
manifest_auction_mode_raw=""
if [[ -n "$manifest_file" ]] && command -v jq >/dev/null 2>&1; then
  manifest_auction_mode_raw="$(jq -r '.params.auction_mode // .params.auctionMode // .params.mode // .params.rules.mode // .params.rules.auctionMode // empty' "$manifest_file" 2>/dev/null | tr -d '\r\n' || true)"
  manifest_auction_mode="$(normalize_auction_mode "$manifest_auction_mode_raw")"
fi

if [[ "$SECOND_PRICE_MODE" == "auto" ]]; then
  case "$manifest_auction_mode" in
    second_price)
      SECOND_PRICE_MODE="1"
      ;;
    first_price|unknown|"")
      SECOND_PRICE_MODE="0"
      ;;
    *)
      SECOND_PRICE_MODE="0"
      ;;
  esac
fi

# 1) preflight: PASS if failed_checks == 0 or status.tsv has no rc!=0 rows.
read_manifest_line() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '($1 == key) {sub(/\r$/, "", $2); print $2; exit}' "$file" 2>/dev/null || true
}

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

# 1.1) build revision alignment check (only when preflight captured expected revision)
version_expected=""
version_actual=""
version_match=""
version_result=""
version_status="SKIP"
version_reason="EXPECTED_BUILD_REVISION not set in preflight manifest"

if [[ -n "$manifest_txt_file" ]]; then
  version_expected="$(read_manifest_line "$manifest_txt_file" "expected_build_revision")"
  if [[ -n "$version_expected" ]]; then
    version_actual="$(read_manifest_line "$manifest_txt_file" "version_revision_actual")"
    version_match="$(read_manifest_line "$manifest_txt_file" "version_revision_match")"
    version_result="$(read_manifest_line "$manifest_txt_file" "version_revision_result")"
    if [[ "$version_match" == "1" ]]; then
      version_status="PASS"
      version_reason="expected=$version_expected actual=${version_actual:-unknown}"
    elif [[ "$version_match" == "0" ]]; then
      version_status="FAIL"
      if [[ -n "$version_result" ]]; then
        version_reason="$version_result"
      else
        version_reason="expected=$version_expected actual=${version_actual:-unknown}"
      fi
      overall="FAIL"
    else
      version_status="SKIP"
      if [[ -n "$version_result" ]]; then
        version_reason="$version_result"
      else
        version_reason="version_revision_match unavailable in manifest"
      fi
    fi
  fi
fi

if [[ "$version_status" == "SKIP" ]] && [[ -n "$version_expected" ]] && [[ -n "$status_file" ]]; then
  version_check_row="$(awk -F'\t' '$1 == "version_revision" {print $2 "|" $3 "|" $4; exit}' "$status_file" 2>/dev/null || true)"
  if [[ -n "$version_check_row" ]]; then
    version_rc="${version_check_row%%|*}"
    if [[ "$version_rc" == "0" ]]; then
      version_status="PASS"
      version_reason="version_revision rc=0"
    else
      version_status="FAIL"
      version_reason="version_revision rc=$version_rc"
      overall="FAIL"
    fi
  else
    version_status="SKIP"
    version_reason="version_revision check row not found"
  fi
fi

record "version_revision_check" "$version_status" "$version_reason" "${manifest_txt_file:-${status_file:-$OUT_DIR}}"

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
  if [[ "$SECOND_PRICE_MODE" == "1" ]]; then
    second_price_status="FAIL"
    second_price_reason="missing second-price report in second-price mode"
    overall="FAIL"
  else
    second_price_status="SKIP"
    second_price_reason="no verify-second-price-payment-summary.tsv"
  fi
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
