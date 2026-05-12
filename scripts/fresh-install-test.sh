#!/usr/bin/env bash
# fresh-install-test.sh
#
# Operator-runnable smoke that proves a clean install actually works.
# Spins up a throwaway MEMPHIS_HOME under /tmp, walks the canonical
# first-run, then tears down. Closes P2 #7 from
# `docs/roadmap/2026-05-11-post-autonomy-todo-and-gap.md` ("does a
# clean install actually work end-to-end").
#
# Usage:
#   bash scripts/fresh-install-test.sh [--keep] [--verbose]
#
# Flags:
#   --keep      Don't delete the temp MEMPHIS_HOME on exit (for
#               post-mortem inspection). Prints the path so you can
#               cd into it.
#   --verbose   Stream memphis stdout/stderr instead of suppressing.
#
# Exit codes:
#   0  — every smoke step passed
#   1  — init failed
#   2  — health failed
#   3  — doctor failed
#   4  — vault round-trip failed
#   5  — chain block write failed
#   9  — prerequisite missing (memphis CLI not on PATH)

set -euo pipefail

KEEP=0
VERBOSE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "[err] unknown flag: $1" >&2
      exit 9
      ;;
  esac
done

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
info() { echo -e "${YELLOW}[..]${NC} $*"; }
fail() { echo -e "${RED}[ERR]${NC} $*" >&2; }

command -v memphis >/dev/null 2>&1 || {
  fail "memphis CLI not on PATH. Run \`npm link\` from the repo root first."
  exit 9
}

STAMP=$(date +%Y%m%d-%H%M%S)
TMP_HOME="/tmp/memphis-fresh-${STAMP}"
LOG="${TMP_HOME}.log"

mkdir -p "${TMP_HOME}"
info "Temp install: ${TMP_HOME}"
info "Log: ${LOG}"

cleanup() {
  if [[ $KEEP -eq 1 ]]; then
    info "Keeping temp install (use --keep was passed)"
    info "Inspect: cd ${TMP_HOME} && cat ${LOG}"
    return
  fi
  rm -rf "${TMP_HOME}" "${LOG}" 2>/dev/null || true
}
trap cleanup EXIT

export MEMPHIS_HOME="${TMP_HOME}"
export MEMPHIS_DATA_DIR="${TMP_HOME}/data"
# Synthetic deterministic secrets for the smoke. The temp home is
# nuked at exit so these never leak, but rotate them in your own
# scripts if you keep one.
export MEMPHIS_INIT_PASSPHRASE_OPERATOR="fresh-install-test-operator-passphrase-2026"
export MEMPHIS_INIT_PASSPHRASE_VAULT="fresh-install-test-vault-passphrase-2026"
export MEMPHIS_INIT_RECOVERY_Q="fresh-install-recovery-question"
export MEMPHIS_INIT_RECOVERY_A="fresh-install-recovery-answer"

run_quiet() {
  if [[ $VERBOSE -eq 1 ]]; then
    "$@" 2>&1 | tee -a "${LOG}"
    return ${PIPESTATUS[0]}
  else
    "$@" >> "${LOG}" 2>&1
  fi
}

# ──────────────────────────────────────────────────────────────────
# Step 1 — `memphis init --non-interactive`
# ──────────────────────────────────────────────────────────────────
info "Step 1/5: memphis init --non-interactive"
if ! run_quiet memphis init \
  --non-interactive \
  --operator-passphrase "${MEMPHIS_INIT_PASSPHRASE_OPERATOR}" \
  --passphrase "${MEMPHIS_INIT_PASSPHRASE_VAULT}" \
  --recovery-question "${MEMPHIS_INIT_RECOVERY_Q}" \
  --recovery-answer "${MEMPHIS_INIT_RECOVERY_A}"; then
  fail "memphis init failed. Last 20 lines of log:"
  tail -20 "${LOG}" >&2
  exit 1
fi
ok "init complete"

# ──────────────────────────────────────────────────────────────────
# Step 2 — `memphis health --json`
# ──────────────────────────────────────────────────────────────────
info "Step 2/5: memphis health --json"
HEALTH_OUT="$(memphis health --json 2>&1 | tee -a "${LOG}" || true)"
# Memphis health JSON uses `"status":"ok"` + `"runtimeStatus":"healthy"`;
# the legacy `"ok": true` envelope was for an earlier shape. Accept any
# of the modern shapes so this stays load-bearing across format
# revisions.
if echo "${HEALTH_OUT}" | grep -qE '"status"\s*:\s*"ok"|"runtimeStatus"\s*:\s*"healthy"|"ok"\s*:\s*true'; then
  ok "health: ok"
else
  fail "memphis health did not return ok / healthy"
  echo "${HEALTH_OUT}" | head -20 >&2
  exit 2
fi

# ──────────────────────────────────────────────────────────────────
# Step 3 — `memphis doctor --json` (allow non-blocking warns)
# ──────────────────────────────────────────────────────────────────
info "Step 3/5: memphis doctor --json"
DOCTOR_OUT="$(memphis doctor --json 2>&1 | tee -a "${LOG}" || true)"
# Fresh install is allowed to surface "vault recovery not yet
# initialized" / "no installed checkpoints" / similar low-severity
# items. The smoke fails ONLY when doctor returns critical issues.
if echo "${DOCTOR_OUT}" | grep -qE '"severity"\s*:\s*"critical"'; then
  fail "memphis doctor flagged critical issues:"
  echo "${DOCTOR_OUT}" | grep -A 2 '"severity": "critical"' | head -20 >&2
  exit 3
fi
ok "doctor: no critical findings"

# ──────────────────────────────────────────────────────────────────
# Step 4 — vault round-trip (write secret → read it back)
# ──────────────────────────────────────────────────────────────────
info "Step 4/5: vault round-trip"
VAULT_TEST_KEY="fresh_install_smoke_$(date +%s)"
VAULT_TEST_VALUE="value-${RANDOM}-${RANDOM}"
# `memphis vault add <key>` writes the value (non-interactive form
# requires --value; --json refuses an interactive prompt). Operator
# auth gates the call — pass via env so it doesn't show in ps output.
export MEMPHIS_OPERATOR_PASSPHRASE="${MEMPHIS_INIT_PASSPHRASE_OPERATOR}"
if ! run_quiet memphis vault add "${VAULT_TEST_KEY}" \
  --value "${VAULT_TEST_VALUE}" \
  --json; then
  fail "vault add failed"
  unset MEMPHIS_OPERATOR_PASSPHRASE
  exit 4
fi
VAULT_READ="$(memphis vault get "${VAULT_TEST_KEY}" --json 2>&1 | tee -a "${LOG}" || true)"
unset MEMPHIS_OPERATOR_PASSPHRASE
if [[ "${VAULT_READ}" != *"${VAULT_TEST_VALUE}"* ]]; then
  fail "vault round-trip: write/read mismatch"
  fail "  wrote: ${VAULT_TEST_VALUE}"
  fail "  read tail: $(echo "${VAULT_READ}" | tail -3)"
  exit 4
fi
ok "vault: write+read round-trip ok"

# ──────────────────────────────────────────────────────────────────
# Step 5 — chain block write (smoke memory write path)
# ──────────────────────────────────────────────────────────────────
info "Step 5/5: chain write smoke"
# `memphis init` already writes the first chain blocks; verify they
# exist + are readable.
CHAIN_OUT="$(memphis chain verify --json 2>&1 | tee -a "${LOG}" || true)"
if echo "${CHAIN_OUT}" | grep -qE '"ok"\s*:\s*true'; then
  ok "chain verify: ok"
else
  fail "chain verify failed"
  echo "${CHAIN_OUT}" | head -20 >&2
  exit 5
fi

# ──────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────
echo
ok "All 5 smoke steps passed."
ok "Fresh install at ${TMP_HOME} is functional."
if [[ $KEEP -eq 1 ]]; then
  echo "  cd ${TMP_HOME}"
  echo "  cat ${LOG}"
fi
exit 0
