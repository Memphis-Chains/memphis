#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_MODE="text"
if [[ "${1:-}" == "--json" ]]; then
  OUTPUT_MODE="json"
fi

# Ensure rustup cargo is available in non-login shells
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
  fi
fi

PASS=0
FAIL=0
RESULTS=()

run_check() {
  local name="$1"
  shift

  if [[ "$OUTPUT_MODE" == "text" ]]; then
    echo "\n=== $name ==="
  fi

  if "$@"; then
    if [[ "$OUTPUT_MODE" == "text" ]]; then
      echo "[PASS] $name"
    fi
    RESULTS+=("PASS|$name")
    PASS=$((PASS + 1))
  else
    local code=$?
    if [[ "$OUTPUT_MODE" == "text" ]]; then
      echo "[FAIL] $name (exit=$code)"
    fi
    RESULTS+=("FAIL|$name|exit=$code")
    FAIL=$((FAIL + 1))
  fi
}

run_check "JS lint" npm run -s lint
run_check "JS typecheck" npm run -s typecheck
run_check "JS tests" npm run -s test
run_check "JS build" npm run -s build
run_check "Rust workspace tests" cargo test --workspace
if [[ "${CI:-}" == "true" && "${FORCE_RUNTIME_SMOKE_IN_CI:-0}" != "1" ]]; then
  RESULTS+=("SKIP|Runtime smoke (ollama bridge)|skipped in CI by default; set FORCE_RUNTIME_SMOKE_IN_CI=1 to run")
  if [[ "$OUTPUT_MODE" == "text" ]]; then
    echo "[SKIP] Runtime smoke (ollama bridge) in CI (set FORCE_RUNTIME_SMOKE_IN_CI=1 to enforce)"
  fi
else
  run_check "Runtime smoke (ollama bridge)" npm run -s smoke:ollama-runtime
fi

# Optional: vault smoke only when pepper exists
if [[ -f ".env.production.local" ]] && grep -q '^MEMPHIS_VAULT_PEPPER=' .env.production.local; then
  run_check "Vault phase1 smoke" ./scripts/vault-phase1-smoke.sh
else
  RESULTS+=("SKIP|Vault phase1 smoke|MEMPHIS_VAULT_PEPPER not configured in .env.production.local")
  if [[ "$OUTPUT_MODE" == "text" ]]; then
    echo "[SKIP] Vault phase1 smoke (MEMPHIS_VAULT_PEPPER not configured in .env.production.local)"
  fi
fi

STAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [[ "$OUTPUT_MODE" == "json" ]]; then
  printf '{"ok":%s,"result":"%s","pass":%d,"fail":%d,"timestamp":"%s","checks":[' \
    "$([[ $FAIL -eq 0 ]] && echo true || echo false)" \
    "$([[ $FAIL -eq 0 ]] && echo PASS || echo FAIL)" \
    "$PASS" "$FAIL" "$STAMP"

  first=1
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r status name info <<< "$row"
    [[ $first -eq 0 ]] && printf ','
    first=0
    if [[ -n "${info:-}" ]]; then
      printf '{"status":"%s","name":"%s","info":"%s"}' "$status" "$name" "$info"
    else
      printf '{"status":"%s","name":"%s"}' "$status" "$name"
    fi
  done
  printf ']}'
  echo
else
  echo "\n========================================"
  echo "Local Quality + Runtime Smoke Summary"
  echo "Repo: $ROOT_DIR"
  echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r status name info <<< "$row"
    if [[ -n "${info:-}" ]]; then
      printf -- "- %-4s %s (%s)\n" "$status" "$name" "$info"
    else
      printf -- "- %-4s %s\n" "$status" "$name"
    fi
  done
  echo "----------------------------------------"
  echo "PASS: $PASS"
  echo "FAIL: $FAIL"
fi

if [[ $FAIL -gt 0 ]]; then
  [[ "$OUTPUT_MODE" == "text" ]] && echo "RESULT: FAIL"
  exit 1
fi

[[ "$OUTPUT_MODE" == "text" ]] && echo "RESULT: PASS"
exit 0
