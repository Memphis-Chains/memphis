#!/usr/bin/env bash
# Memphis post-install smoke test for operators.
#
# Non-destructive verifier that the installer + memphis init + service
# install all left a working runtime behind. Run after the post-install
# banner to catch silent failures before they hit operator usage.
#
# Distinct from scripts/smoke-test.sh which is a build-time integration
# test. This file is operator-facing — wraps the public CLI, no
# bridge access.
#
# Exit 0 if every check is green. Exit 1 if any red.
#
# Usage:
#   bash scripts/post-install-smoke.sh             # human-readable
#   bash scripts/post-install-smoke.sh --json      # machine-readable
#   bash scripts/post-install-smoke.sh --strict    # fail on warnings (yellow)

set -uo pipefail

JSON=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --json)   JSON=1 ;;
    --strict) STRICT=1 ;;
    --help)
      cat <<'EOF'
Usage: post-install-smoke.sh [--json] [--strict]
  --json    machine-readable JSON output
  --strict  treat warnings (yellow) as failures
EOF
      exit 0 ;;
  esac
done

if [ "$JSON" = "0" ] && [ -t 1 ]; then
  C_GREEN="\033[1;32m"; C_RED="\033[1;31m"; C_YELLOW="\033[1;33m"
  C_BLUE="\033[1;34m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_BLUE=""; C_DIM=""; C_RESET=""
fi

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
JSON_RESULTS=()

json_escape() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, json; print(json.dumps(sys.stdin.read()))'
  else
    # tiny fallback — handles common cases, not all unicode
    sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n' | sed 's/\\n$//' | awk '{print "\""$0"\""}'
  fi
}

record() {
  local status="$1" name="$2" detail="$3"
  case "$status" in
    pass) PASS_COUNT=$((PASS_COUNT+1));
          [ "$JSON" = "0" ] && printf "  ${C_GREEN}✓${C_RESET}  %-32s ${C_DIM}%s${C_RESET}\n" "$name" "$detail" ;;
    warn) WARN_COUNT=$((WARN_COUNT+1));
          [ "$JSON" = "0" ] && printf "  ${C_YELLOW}!${C_RESET}  %-32s ${C_DIM}%s${C_RESET}\n" "$name" "$detail" ;;
    fail) FAIL_COUNT=$((FAIL_COUNT+1));
          [ "$JSON" = "0" ] && printf "  ${C_RED}✗${C_RESET}  %-32s ${C_DIM}%s${C_RESET}\n" "$name" "$detail" ;;
  esac
  JSON_RESULTS+=("{\"check\":\"$name\",\"status\":\"$status\",\"detail\":$(printf '%s' "$detail" | json_escape)}")
}

section() { [ "$JSON" = "0" ] && printf "\n${C_BLUE}▸ %s${C_RESET}\n" "$1"; }

[ "$JSON" = "0" ] && cat <<EOF

╔════════════════════════════════════════════════════════════════╗
║                Memphis post-install smoke test                 ║
╚════════════════════════════════════════════════════════════════╝
EOF

# 1. CLI on PATH
section "CLI"
if command -v memphis >/dev/null 2>&1; then
  ver=$(memphis --version 2>/dev/null | head -1 || echo "unknown")
  record pass "memphis on PATH" "${ver:-found}"
else
  record fail "memphis on PATH" "command not found — try 'cd ~/.memphis/memphis && npm link'"
fi

# 2. Service running
section "Runtime"
if systemctl --user is-active memphis.service >/dev/null 2>&1; then
  pid=$(systemctl --user show memphis.service -p MainPID --value 2>/dev/null || echo "?")
  record pass "systemd service active" "PID=$pid"
else
  if systemctl --user list-unit-files memphis.service 2>/dev/null | grep -q memphis; then
    record fail "systemd service active" "unit installed but not active — try 'systemctl --user start memphis.service'"
  else
    record warn "systemd service active" "unit not installed — try 'memphis service install'"
  fi
fi

# 3. HTTP /health
host="${MEMPHIS_HOST:-127.0.0.1}"
port="${MEMPHIS_PORT:-3100}"
if curl -fsS --max-time 5 "http://$host:$port/health" >/dev/null 2>&1; then
  record pass "HTTP /health" "$host:$port reachable"
else
  record fail "HTTP /health" "$host:$port unreachable — runtime may not be listening"
fi

# 4. memphis health
if memphis health >/dev/null 2>&1; then
  record pass "memphis health" "exit 0"
else
  record warn "memphis health" "non-zero exit"
fi

# 5. Doctor
section "Doctor"
if memphis doctor >/dev/null 2>&1; then
  record pass "memphis doctor" "exit 0"
else
  record warn "memphis doctor" "non-zero exit — run 'memphis doctor' for detail"
fi

# 6. Vault
section "Storage"
if memphis vault list >/dev/null 2>&1; then
  count=$(memphis vault list 2>/dev/null | grep -cE "^[[:space:]]*[•-][[:space:]]" || true)
  record pass "vault initialized" "$count entries"
else
  record warn "vault initialized" "list failed — try 'memphis init' if first install"
fi

# 7. Chains writable
chain_dir="${MEMPHIS_DATA:-$HOME/.memphis}/chains"
if [ -d "$chain_dir" ] && [ -w "$chain_dir" ]; then
  count=$(find "$chain_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l || echo 0)
  record pass "chain root writable" "$count chains at $chain_dir"
else
  record fail "chain root writable" "$chain_dir missing or read-only"
fi

# 8. Providers
section "Providers"
if providers_out=$(memphis providers list 2>&1); then
  configured=$(printf '%s\n' "$providers_out" | grep -cE "^●|^◐" || true)
  if [ "$configured" -gt 0 ]; then
    record pass "providers configured" "$configured up"
  else
    record warn "providers configured" "no providers up — check Ollama or vault keys"
  fi
else
  record warn "providers configured" "providers list failed"
fi

# 9. Voice (only when MEMPHIS_VOICE_MODE=local)
section "Voice (optional)"
mode="${MEMPHIS_VOICE_MODE:-}"
if [ -z "$mode" ] && [ -f "$HOME/memphis/.env" ]; then
  mode=$(grep -E '^MEMPHIS_VOICE_MODE=' "$HOME/memphis/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
fi
if [ "$mode" = "local" ]; then
  whisper_url="${WHISPER_SERVER_URL:-http://127.0.0.1:9000}"
  piper_url="${PIPER_SERVER_URL:-http://127.0.0.1:5500}"
  if curl -fsS --max-time 3 "$whisper_url/health" >/dev/null 2>&1; then
    record pass "STT (whisper)" "$whisper_url reachable"
  else
    record warn "STT (whisper)" "$whisper_url unreachable — try 'memphis voice install --restart'"
  fi
  if curl -fsS --max-time 3 "$piper_url/health" >/dev/null 2>&1; then
    record pass "TTS (piper)" "$piper_url reachable"
  else
    record warn "TTS (piper)" "$piper_url unreachable — try 'memphis voice install --restart'"
  fi
else
  record pass "voice stack" "MEMPHIS_VOICE_MODE=${mode:-cloud/auto} — local stack not required"
fi

# 10. Summary
if [ "$JSON" = "1" ]; then
  total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
  printf '{"total":%d,"pass":%d,"warn":%d,"fail":%d,"checks":[%s]}\n' \
    "$total" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" \
    "$(IFS=,; echo "${JSON_RESULTS[*]}")"
else
  printf "\n${C_DIM}─────────────────────────────────────────${C_RESET}\n"
  printf "  ${C_GREEN}pass:${C_RESET} %d   ${C_YELLOW}warn:${C_RESET} %d   ${C_RED}fail:${C_RESET} %d\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  if [ "$FAIL_COUNT" -eq 0 ] && [ "$WARN_COUNT" -eq 0 ]; then
    printf "  ${C_GREEN}all green — Memphis is ready${C_RESET}\n\n"
  elif [ "$FAIL_COUNT" -eq 0 ]; then
    printf "  ${C_YELLOW}functional, but some non-critical checks need attention${C_RESET}\n\n"
  else
    printf "  ${C_RED}some checks failed — fix above before using Memphis${C_RESET}\n\n"
  fi
fi

[ "$FAIL_COUNT" -gt 0 ] && exit 1
[ "$STRICT" = "1" ] && [ "$WARN_COUNT" -gt 0 ] && exit 1
exit 0
