#!/usr/bin/env bash
# verify-installation.sh
# Verifies Memphis v5 prerequisites and runtime presence.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass_count=0
fail_count=0

ok(){ echo -e "${GREEN}PASS${NC}: $*"; pass_count=$((pass_count+1)); }
warn(){ echo -e "${YELLOW}WARN${NC}: $*"; }
fail(){ echo -e "${RED}FAIL${NC}: $*"; fail_count=$((fail_count+1)); }

check_cmd(){
  local name="$1"
  local cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    ok "$name"
  else
    fail "$name"
  fi
}

check_version_min(){
  local label="$1"; local cmd="$2"; local min_major="$3"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "$label not found"
    return
  fi
  local ver major
  ver="$($cmd --version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n1 || true)"
  major="${ver%%.*}"
  if [[ -n "$major" ]] && (( major >= min_major )); then
    ok "$label version $ver (>= $min_major)"
  else
    fail "$label version too low ($ver, require >= $min_major)"
  fi
}

echo "== Memphis v5 Installation Verification =="

check_version_min "Node.js" node 18
check_version_min "npm" npm 9
check_cmd "Rust toolchain (rustc)" "command -v rustc"
check_cmd "Cargo" "command -v cargo"
check_cmd "Git" "command -v git"
check_cmd "Python3" "command -v python3"

if command -v ollama >/dev/null 2>&1; then
  ok "Ollama detected ($(ollama --version 2>/dev/null | head -n1))"
else
  warn "Ollama not found (optional unless using local embeddings)"
fi

if command -v memphis >/dev/null 2>&1; then
  ok "Memphis binary detected"
else
  warn "Memphis binary not in PATH (try npm link or npm run cli -- --help)"
fi

if [[ -f .env || -f .env.example ]]; then
  ok "Configuration file present (.env or .env.example)"
else
  warn "No .env/.env.example in current directory"
fi

echo ""
echo "Summary: pass=${pass_count}, fail=${fail_count}"

if (( fail_count > 0 )); then
  echo -e "${RED}Result: FAILED${NC}"
  exit 1
fi

echo -e "${GREEN}Result: PASSED${NC}"
exit 0
