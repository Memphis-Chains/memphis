#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_MODE="text"
AUTOFIX=0
SKIP_TESTS=0
SKIP_BUILD=0
SKIP_BENCH=0

usage() {
  cat <<'USAGE'
Usage: ./scripts/nightly-crystal-pass.sh [options]

Options:
  --json         Print machine-readable JSON output
  --autofix      Run formatter/lint fixes when checks fail
  --skip-tests   Skip full test suite
  --skip-build   Skip build step
  --skip-bench   Skip retrieval benchmark gate
  -h, --help     Show this help
USAGE
}

while (($# > 0)); do
  case "$1" in
    --json)
      OUTPUT_MODE="json"
      ;;
    --autofix)
      AUTOFIX=1
      ;;
    --skip-tests)
      SKIP_TESTS=1
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --skip-bench)
      SKIP_BENCH=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

PASS=0
FAIL=0
RESULTS=()

print_text() {
  if [[ "$OUTPUT_MODE" == "text" ]]; then
    echo "$@"
  fi
}

record_result() {
  local status="$1"
  local name="$2"
  local duration_sec="$3"
  local info="${4:-}"

  RESULTS+=("${status}|${name}|${duration_sec}|${info}")
  if [[ "$status" == "PASS" || "$status" == "SKIP" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_check() {
  local name="$1"
  shift

  local start_ts end_ts duration_sec
  start_ts="$(date +%s)"
  if "$@"; then
    end_ts="$(date +%s)"
    duration_sec=$((end_ts - start_ts))
    record_result "PASS" "$name" "$duration_sec"
    print_text "[PASS] ${name} (${duration_sec}s)"
    return 0
  fi

  local exit_code=$?
  end_ts="$(date +%s)"
  duration_sec=$((end_ts - start_ts))
  record_result "FAIL" "$name" "$duration_sec" "exit=${exit_code}"
  print_text "[FAIL] ${name} (${duration_sec}s, exit=${exit_code})"
  return "$exit_code"
}

skip_check() {
  local name="$1"
  local reason="$2"
  record_result "SKIP" "$name" "0" "$reason"
  print_text "[SKIP] ${name} (${reason})"
}

print_text "=== Nightly Crystal Pass ==="
print_text "Repo: ${ROOT_DIR}"
print_text "Timestamp (UTC): $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

format_failed=0
run_check "Format check" npm run -s format:check || format_failed=1
if [[ "$format_failed" -eq 1 && "$AUTOFIX" -eq 1 ]]; then
  run_check "Format write (autofix)" npm run -s format
  run_check "Format check (post-autofix)" npm run -s format:check
fi

lint_failed=0
run_check "Lint" npm run -s lint || lint_failed=1
if [[ "$lint_failed" -eq 1 && "$AUTOFIX" -eq 1 ]]; then
  run_check "Lint fix (autofix)" npx eslint . --fix
  run_check "Lint (post-autofix)" npm run -s lint
fi

run_check "Typecheck" npm run -s typecheck

if [[ "$SKIP_TESTS" -eq 1 ]]; then
  skip_check "Test" "disabled by --skip-tests"
else
  run_check "Test" npm run -s test
fi

if [[ "$SKIP_BENCH" -eq 1 ]]; then
  skip_check "Retrieval benchmark gate" "disabled by --skip-bench"
else
  run_check "Retrieval benchmark gate" npm run -s bench:retrieval:gate
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  skip_check "Build" "disabled by --skip-build"
else
  run_check "Build" npm run -s build
fi

if [[ "$AUTOFIX" -eq 1 ]]; then
  changed_files="$(git status --porcelain | wc -l | tr -d ' ')"
else
  changed_files="0"
fi

report_dir="${MEMPHIS_NIGHTLY_REPORT_DIR:-.memphis-intake/nightly-quality}"
mkdir -p "$report_dir"
stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
report_path="${report_dir}/nightly-${stamp}.json"
latest_path="${report_dir}/latest.json"
ok_json="$([[ "$FAIL" -eq 0 ]] && echo true || echo false)"
mode_json="$([[ "$AUTOFIX" -eq 1 ]] && echo autofix || echo check)"

{
  printf '{"ok":%s,"mode":"%s","timestamp":"%s","pass":%d,"fail":%d,"autofixChangedFiles":%s,"results":[' \
    "$ok_json" \
    "$mode_json" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$PASS" \
    "$FAIL" \
    "$changed_files"

  first=1
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r status name duration info <<< "$row"
    [[ "$first" -eq 0 ]] && printf ','
    first=0

    if [[ -n "${info:-}" ]]; then
      printf '{"status":"%s","name":"%s","durationSec":%s,"info":"%s"}' \
        "$status" \
        "$name" \
        "$duration" \
        "$info"
    else
      printf '{"status":"%s","name":"%s","durationSec":%s}' \
        "$status" \
        "$name" \
        "$duration"
    fi
  done

  printf ']}'
  echo
} > "$report_path"
cp "$report_path" "$latest_path"

if [[ "$OUTPUT_MODE" == "json" ]]; then
  cat "$latest_path"
else
  echo
  echo "Summary: pass=${PASS} fail=${FAIL} mode=${mode_json}"
  echo "Report: ${latest_path}"
fi

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
