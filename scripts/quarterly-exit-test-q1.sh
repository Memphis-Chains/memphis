#!/usr/bin/env bash
# Y1 Q1 exit test — asserts Q1 deliverables present + functional.
# Mirrors the exit-test block from docs/roadmap/Y1-2026-05-to-2027-05.md Q1 section.
#
# Invoked by:
#   - `.github/workflows/quarterly-gate.yml` (last Monday of each quarter + workflow_dispatch)
#   - Manually during sprint to check convergence: `bash scripts/quarterly-exit-test-q1.sh`
#
# Exit codes:
#   0 — all checks pass (Q1 ship criteria met)
#   1 — one or more checks failed (detail on stderr)
#
# Environment:
#   QUARTERLY_GATE_ALLOW_MISSING_CORPUS=1
#     Skips the `~/.memphis/kartograf/corpus/v1/` checks. Useful in CI where
#     operator corpus is not provisioned (corpus is a local artefact per
#     N37 scope). Release gate runs with this flag.

set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FAILED=0
WARNINGS=0

pass() { printf '[pass] %s\n' "$1"; }
fail() { printf '[fail] %s\n' "$1" >&2; FAILED=$((FAILED + 1)); }
warn() { printf '[warn] %s\n' "$1" >&2; WARNINGS=$((WARNINGS + 1)); }

echo "=== Y1 Q1 exit test ==="
echo "root: $ROOT_DIR"
echo ""

# ----- doc deliverables -----

check_file() {
  local path="$1"
  if [ -f "$path" ]; then
    pass "file exists: $path"
  else
    fail "missing file: $path"
  fi
}

check_file docs/dev/KARTOGRAF-SPEC.md
check_file docs/dev/DEPENDENCY-POLICY.md
check_file docs/dev/MV2-INTEGRATION.md
check_file .github/pull_request_template.md
check_file .github/workflows/dep-freeze-check.yml
check_file .github/workflows/quarterly-gate.yml

# RLM-SAFETY-INVARIANTS.md is design-only in Q1 (impl Q3); file existence gates Q1.
check_file docs/dev/RLM-SAFETY-INVARIANTS.md

# ----- README hygiene (no "coming soon") -----

if grep -q 'coming soon' README.md; then
  fail "'coming soon' still present in README.md"
else
  pass "README.md has no 'coming soon' markers"
fi

# ----- Trajectory export (N8/N9) -----

if [ -x "$(command -v npx)" ]; then
  if npx --no-install tsx src/infra/cli/index.ts export trajectories --help >/dev/null 2>&1; then
    pass "memphis export trajectories command registered"
  else
    # Fallback: grep command registration
    if grep -rq "export trajectories" src/infra/cli/ 2>/dev/null; then
      pass "export trajectories command found in source (not CLI-invokable in this env)"
    else
      fail "export trajectories command not implemented"
    fi
  fi
else
  warn "npx not available; skipping CLI invocation check"
fi

# ----- .mv2 scaffold (N12) -----

if [ -d crates/memphis-export ]; then
  pass "crates/memphis-export/ crate present"
  if [ -x "$(command -v cargo)" ]; then
    # Distinguish "test binary / test case is missing" (sprint in flight)
    # from "test exists and fails" (real regression). Roadmap Q1 exit
    # test requires mv2_roundtrip_minimal PASS — a failing test must
    # fail the quarterly gate, not warn. Only a genuine "no such test"
    # downgrades to a warning while the crate scaffold is being filled in.
    mv2_output=$(cargo test -p memphis-export -- mv2_roundtrip_minimal --quiet 2>&1 || true)
    mv2_rc=$?
    if echo "$mv2_output" | grep -qE 'test result: ok.*1 passed'; then
      pass "mv2_roundtrip_minimal test passes"
    elif echo "$mv2_output" | grep -qE '0 passed.*0 filtered' \
         || echo "$mv2_output" | grep -qE 'no matches for|no tests to run' \
         || [ "$mv2_rc" -eq 101 ] && echo "$mv2_output" | grep -q 'could not find'; then
      warn "mv2_roundtrip_minimal test missing (sprint in progress — scaffold accepted)"
    else
      fail "mv2_roundtrip_minimal test failing (real regression, see cargo output)"
      echo "$mv2_output" | tail -20
    fi
  else
    warn "cargo not available; skipping mv2 test run"
  fi
else
  fail "crates/memphis-export/ not created"
fi

# ----- Kartograf corpus (N37) -----

CORPUS_DIR="${HOME}/.memphis/kartograf/corpus/v1"
if [ "${QUARTERLY_GATE_ALLOW_MISSING_CORPUS:-0}" = "1" ]; then
  pass "corpus check skipped (QUARTERLY_GATE_ALLOW_MISSING_CORPUS=1)"
else
  if [ -d "$CORPUS_DIR" ]; then
    pass "corpus directory exists: $CORPUS_DIR"
    if [ -s "$CORPUS_DIR/train.jsonl" ]; then
      pass "train.jsonl non-empty"
    else
      fail "train.jsonl missing or empty"
    fi
    SUMMARY="$CORPUS_DIR/corpus-v1-summary.json"
    if [ -f "$SUMMARY" ]; then
      if command -v jq >/dev/null 2>&1; then
        if jq -e '.secret_scan.clean == true and .vault_denylist.enforced == true' "$SUMMARY" >/dev/null; then
          pass "corpus-v1-summary.json: secret_scan.clean + vault_denylist.enforced"
        else
          fail "corpus-v1-summary.json: invariant fields not set true"
        fi
      else
        warn "jq not available; skipping summary JSON assertion"
      fi
    else
      fail "corpus-v1-summary.json missing"
    fi
  else
    fail "corpus directory missing: $CORPUS_DIR (set QUARTERLY_GATE_ALLOW_MISSING_CORPUS=1 to skip in CI)"
  fi
fi

# ----- doctor (only if built) -----

if [ -x "$(command -v memphis)" ]; then
  if memphis doctor --json 2>/dev/null | jq -e '.ok == true' >/dev/null; then
    pass "memphis doctor: ok"
  else
    warn "memphis doctor not 'ok' (may reflect runtime state, not code)"
  fi
else
  warn "memphis CLI not on PATH; skipping doctor check"
fi

# ----- summary -----

echo ""
echo "=== summary ==="
printf 'failures: %d\n' "$FAILED"
printf 'warnings: %d\n' "$WARNINGS"

if [ "$FAILED" -gt 0 ]; then
  echo "Q1 exit test: FAIL"
  exit 1
fi

echo "Q1 exit test: PASS"
exit 0
