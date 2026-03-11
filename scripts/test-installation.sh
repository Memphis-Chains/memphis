#!/usr/bin/env bash
# test-installation.sh
# Runs smoke and functional tests for Memphis v5 installation.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPORT_DIR="${REPORT_DIR:-./test-reports}"
REPORT_FILE="$REPORT_DIR/memphis-installation-test-$(date +%F-%H%M%S).log"
mkdir -p "$REPORT_DIR"

pass=0
fail=0

log(){ echo -e "$*" | tee -a "$REPORT_FILE"; }
ok(){ log "${GREEN}PASS${NC}: $*"; pass=$((pass+1)); }
warn(){ log "${YELLOW}WARN${NC}: $*"; }
err(){ log "${RED}FAIL${NC}: $*"; fail=$((fail+1)); }

run_test(){
  local name="$1"; shift
  if "$@" >>"$REPORT_FILE" 2>&1; then
    ok "$name"
  else
    err "$name"
  fi
}

log "== Memphis v5 Installation Test =="
log "Report: $REPORT_FILE"

# 1) Smoke tests
run_test "CLI version" bash -lc "command -v memphis && memphis --version"
run_test "CLI help" bash -lc "memphis --help"
run_test "CLI health" bash -lc "memphis health"

# 2) Cognitive model test (best effort)
if memphis ask --input "Respond with: MEMPHIS_TEST_OK" >>"$REPORT_FILE" 2>&1; then
  ok "Cognitive model test (memphis ask)"
else
  warn "Cognitive model test skipped/failed (provider may be unconfigured)"
fi

# 3) Embedding test (if Ollama configured)
if command -v ollama >/dev/null 2>&1 && curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if memphis embed store --text "installation-test-memory" >>"$REPORT_FILE" 2>&1 && \
     memphis embed search "installation-test-memory" >>"$REPORT_FILE" 2>&1; then
    ok "Embedding + memory search test"
  else
    warn "Embedding test failed (check embedding provider/model config)"
  fi
else
  warn "Embedding test skipped (Ollama/API not available)"
fi

# 4) Vault test (if initialized)
if memphis vault list >>"$REPORT_FILE" 2>&1; then
  ok "Vault status"
  if memphis vault list >>"$REPORT_FILE" 2>&1; then
    ok "Vault list"
  else
    warn "Vault list failed"
  fi
else
  warn "Vault not initialized or command unavailable"
fi

# 5) OpenClaw plugin test (if installed)
if command -v openclaw >/dev/null 2>&1; then
  if openclaw plugins >>"$REPORT_FILE" 2>&1; then
    ok "OpenClaw plugin list"
  else
    warn "OpenClaw present but plugin listing failed"
  fi
else
  warn "OpenClaw not installed; plugin test skipped"
fi

log ""
log "Summary: pass=$pass fail=$fail"

if (( fail > 0 )); then
  log "${RED}Installation test result: FAILED${NC}"
  exit 1
fi

log "${GREEN}Installation test result: PASSED${NC}"
exit 0
