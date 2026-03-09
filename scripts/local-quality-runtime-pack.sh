#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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
  echo "\n=== $name ==="
  if "$@"; then
    echo "[PASS] $name"
    RESULTS+=("PASS|$name")
    PASS=$((PASS + 1))
  else
    local code=$?
    echo "[FAIL] $name (exit=$code)"
    RESULTS+=("FAIL|$name|exit=$code")
    FAIL=$((FAIL + 1))
  fi
}

run_check "JS lint" npm run -s lint
run_check "JS typecheck" npm run -s typecheck
run_check "JS tests" npm run -s test
run_check "JS build" npm run -s build
run_check "Rust workspace tests" cargo test --workspace
run_check "Runtime smoke (ollama bridge)" ./scripts/smoke-ollama-bridge-runtime.sh

# Optional: vault smoke only when pepper exists
if [[ -f ".env.production.local" ]] && grep -q '^MEMPHIS_VAULT_PEPPER=' .env.production.local; then
  run_check "Vault phase1 smoke" ./scripts/vault-phase1-smoke.sh
else
  RESULTS+=("SKIP|Vault phase1 smoke|MEMPHIS_VAULT_PEPPER not configured in .env.production.local")
  echo "[SKIP] Vault phase1 smoke (MEMPHIS_VAULT_PEPPER not configured in .env.production.local)"
fi

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

if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi

echo "RESULT: PASS"
exit 0
