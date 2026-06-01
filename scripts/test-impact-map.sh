#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"
HEAD_REF="${HEAD_REF:-HEAD}"
STRICT="${STRICT:-0}"

usage() {
  cat <<'USAGE'
usage: scripts/test-impact-map.sh

Report code changes that do not have an obvious nearby test signal.

Environment:
  BASE_REF   base ref for diff, default origin/main
  HEAD_REF   head ref for diff, default HEAD
  STRICT     when 1, exit non-zero if a code change has no test signal

This is a reviewer aid, not a coverage proof. It intentionally uses nearby
conventions only: Go *_test.go in the package, web *.test/spec files or
__tests__, and generic sibling test files for tools/scripts.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! git rev-parse --verify "${BASE_REF}" >/dev/null 2>&1; then
  echo "error: BASE_REF '${BASE_REF}' is not a known ref; fetch it or set BASE_REF" >&2
  exit 2
fi
if ! git rev-parse --verify "${HEAD_REF}" >/dev/null 2>&1; then
  echo "error: HEAD_REF '${HEAD_REF}' is not a known ref" >&2
  exit 2
fi

is_test_file() {
  local path="$1"
  case "${path}" in
    *_test.go|*.test.js|*.test.jsx|*.test.ts|*.test.tsx|*.spec.js|*.spec.jsx|*.spec.ts|*.spec.tsx|*/__tests__/*)
      return 0
      ;;
  esac
  return 1
}

is_code_file() {
  local path="$1"
  case "${path}" in
    apps/*.go|apps/*.js|apps/*.jsx|apps/*.ts|apps/*.tsx|apps/*.mjs|apps/*.cjs|apps/*.py)
      return 0
      ;;
    tools/*.go|tools/*.py|tools/*.js|tools/*.ts|tools/*.sh|scripts/*.sh)
      return 0
      ;;
  esac
  return 1
}

append_if_exists() {
  local candidate="$1"
  if [[ -e "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
  fi
}

find_go_tests() {
  local path="$1"
  local dir
  dir="$(dirname "${path}")"
  find "${dir}" -maxdepth 1 -type f -name '*_test.go' 2>/dev/null | sort
}

find_web_tests() {
  local path="$1"
  local dir base stem ext
  dir="$(dirname "${path}")"
  base="$(basename "${path}")"
  stem="${base%.*}"
  for ext in js jsx ts tsx mjs cjs; do
    append_if_exists "${dir}/${stem}.test.${ext}"
    append_if_exists "${dir}/${stem}.spec.${ext}"
    append_if_exists "${dir}/__tests__/${stem}.test.${ext}"
    append_if_exists "${dir}/__tests__/${stem}.spec.${ext}"
  done
  find "${dir}" -maxdepth 1 -type f \( -name '*.test.js' -o -name '*.test.jsx' -o -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) 2>/dev/null | sort
}

find_generic_tests() {
  local path="$1"
  local dir base stem
  dir="$(dirname "${path}")"
  base="$(basename "${path}")"
  stem="${base%.*}"
  find "${dir}" -maxdepth 1 -type f \( -name '*test*' -o -name "${stem}_test.*" -o -name "test_${stem}.*" \) 2>/dev/null | sort
}

mapfile -t changed < <(git diff --name-only --diff-filter=ACMR "${BASE_REF}...${HEAD_REF}" --)

if [[ ${#changed[@]} -eq 0 ]]; then
  echo "No changed files between ${BASE_REF} and ${HEAD_REF}."
  exit 0
fi

echo "Test impact map: ${BASE_REF}...${HEAD_REF}"
echo

missing=0
code_seen=0
test_seen=0

for path in "${changed[@]}"; do
  if is_test_file "${path}"; then
    test_seen=$((test_seen + 1))
    printf 'TEST_CHANGE  %s\n' "${path}"
    continue
  fi

  if ! is_code_file "${path}"; then
    printf 'SKIP         %s\n' "${path}"
    continue
  fi

  code_seen=$((code_seen + 1))
  mapfile -t candidates < <(
    case "${path}" in
      *.go) find_go_tests "${path}" ;;
      *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs) find_web_tests "${path}" ;;
      *) find_generic_tests "${path}" ;;
    esac | awk '!seen[$0]++'
  )

  if [[ ${#candidates[@]} -eq 0 ]]; then
    missing=$((missing + 1))
    printf 'NO_SIGNAL    %s\n' "${path}"
  else
    printf 'HAS_SIGNAL   %s\n' "${path}"
    for candidate in "${candidates[@]}"; do
      printf '             -> %s\n' "${candidate}"
    done
  fi
done

echo
printf 'Summary: code_files=%d test_files=%d no_signal=%d strict=%s\n' "${code_seen}" "${test_seen}" "${missing}" "${STRICT}"

if [[ "${STRICT}" == "1" && ${missing} -gt 0 ]]; then
  echo "strict mode failed: at least one code change has no nearby test signal" >&2
  exit 1
fi
