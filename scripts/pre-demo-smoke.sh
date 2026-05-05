#!/usr/bin/env bash
#
# Pre-demo smoke test — runs through the T-2h checklist from
# docs/operator/pre-demo-checklist.md as a single command.
#
# Returns exit code 0 if every probe is green, 1 otherwise. Designed
# to be run 2 hours before any public-facing demo so an operator
# catches "I forgot to deploy that fix" / "service died at 3am" /
# "voice stack stopped" issues before the audience is watching.
#
# Usage:
#   ./scripts/pre-demo-smoke.sh                  # full check
#   ./scripts/pre-demo-smoke.sh --skip-build     # skip rebuild step
#   ./scripts/pre-demo-smoke.sh --json           # machine-readable
#
# Conservative by design: if a probe doesn't apply (e.g. no Telegram
# config, no Brave key) it's a SKIP not a FAIL. The exit code only
# trips on actual breakage.

set -uo pipefail

# ── arg parse ─────────────────────────────────────────────────────────
SKIP_BUILD=0
JSON_OUTPUT=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --json) JSON_OUTPUT=1 ;;
    --help|-h)
      sed -n '3,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ── colors (no chalk dep — pure shell) ────────────────────────────────
if [[ -t 1 && $JSON_OUTPUT -eq 0 ]]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GRAY=$'\033[90m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; GRAY=''; BOLD=''; RESET=''
fi

# ── result accumulator ────────────────────────────────────────────────
declare -a CHECKS_NAME CHECKS_LEVEL CHECKS_DETAIL
TOTAL_FAILS=0
TOTAL_WARNS=0

record() {
  local name="$1" level="$2" detail="$3"
  CHECKS_NAME+=("$name")
  CHECKS_LEVEL+=("$level")
  CHECKS_DETAIL+=("$detail")
  case "$level" in
    fail) TOTAL_FAILS=$((TOTAL_FAILS + 1)) ;;
    warn) TOTAL_WARNS=$((TOTAL_WARNS + 1)) ;;
  esac
  if [[ $JSON_OUTPUT -eq 0 ]]; then
    local icon color
    case "$level" in
      pass) icon='✓'; color="$GREEN" ;;
      warn) icon='⚠'; color="$YELLOW" ;;
      fail) icon='✗'; color="$RED" ;;
      *)    icon='·'; color="$GRAY" ;;
    esac
    printf '  %s%s%s %s — %s\n' "$color" "$icon" "$RESET" "$name" "$detail"
  fi
}

if [[ $JSON_OUTPUT -eq 0 ]]; then
  printf '\n%sMemphis pre-demo smoke%s — %s\n\n' "$BOLD" "$RESET" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
fi

# ── 1. Git state — what's NOT yet live in dist/ ──────────────────────
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  service_start_iso=$(systemctl --user show memphis -p ActiveEnterTimestamp --value 2>/dev/null || echo '')
  if [[ -n "$service_start_iso" && "$service_start_iso" != 'n/a' ]]; then
    new_commits=$(git log --oneline --since "$service_start_iso" main 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${new_commits:-0}" -gt 0 ]]; then
      record 'git: commits since service start' 'warn' "$new_commits commit(s) on main not yet in running service — restart memphis after rebuild"
    else
      record 'git: commits since service start' 'pass' 'service running latest main'
    fi
  else
    record 'git: commits since service start' 'warn' 'memphis service not running yet — start with `systemctl --user start memphis`'
  fi
else
  record 'git: repo' 'warn' 'not a git repo — skipping commit drift check'
fi

# ── 2. Build (npm + napi) — unless --skip-build ───────────────────────
if [[ $SKIP_BUILD -eq 0 ]]; then
  if npm run build:rust:release >/tmp/pre-demo-build.log 2>&1; then
    record 'build: rust release' 'pass' 'libmemphis_napi.so + index.node up to date'
  else
    record 'build: rust release' 'fail' "rust build failed (see /tmp/pre-demo-build.log)"
  fi
  if npx tsc -p tsconfig.json >/tmp/pre-demo-tsc.log 2>&1; then
    record 'build: tsc' 'pass' 'dist/ refreshed'
  else
    record 'build: tsc' 'fail' "tsc failed (see /tmp/pre-demo-tsc.log)"
  fi
else
  record 'build' 'warn' '--skip-build set; dist/ may be stale'
fi

# ── 3. Memphis service health ─────────────────────────────────────────
if systemctl --user is-active --quiet memphis; then
  uptime=$(ps -o etime= -p "$(systemctl --user show memphis -p MainPID --value)" 2>/dev/null | tr -d ' ' || echo 'unknown')
  restarts=$(systemctl --user show memphis -p NRestarts --value 2>/dev/null || echo '?')
  record 'service: memphis active' 'pass' "uptime $uptime, NRestarts=$restarts"
else
  record 'service: memphis active' 'fail' 'memphis.service not active — check `journalctl --user -u memphis`'
fi

# ── 4. Recent crashes (since service start, capped at 24h) ───────────
# Crash window = max(service uptime, 1h) — counting crashes from BEFORE
# the current process start would surface old SIGILLs that have already
# been fixed. Bounded by 24h ceiling so a multi-day-uptime instance
# doesn't paginate through ancient logs.
service_active_iso=$(systemctl --user show memphis -p ActiveEnterTimestamp --value 2>/dev/null || echo '')
if [[ -n "$service_active_iso" && "$service_active_iso" != 'n/a' ]]; then
  crash_window="--since=$service_active_iso"
else
  crash_window='--since=1 hour ago'
fi
crash_count=$(journalctl --user -u memphis $crash_window 2>/dev/null | grep -cE 'ILL|SEGV|core-dump' || true)
if [[ "${crash_count:-0}" -eq 0 ]]; then
  record 'service: no crashes since start' 'pass' 'zero SIGILL / SEGV / core-dump events'
else
  record 'service: no crashes since start' 'fail' "$crash_count crash event(s) since service start — investigate"
fi

# ── 5. memphis doctor (let it speak for itself) ──────────────────────
# `memphis doctor` exits non-zero when any required check fails, but
# the JSON it prints still describes the state correctly. Capture
# stdout regardless of exit code so we can read the report.
doctor_out=$(memphis doctor --json 2>/dev/null || true)
if [[ -n "$doctor_out" ]]; then
  fail_count=$(echo "$doctor_out" | grep -oE '"fail":[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || echo '?')
  warn_count=$(echo "$doctor_out" | grep -oE '"warn":[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || echo '?')
  required_fail=$(echo "$doctor_out" | grep -oE '"requiredFailures":[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || echo '0')
  if [[ "$fail_count" == '0' && "$required_fail" == '0' ]]; then
    record 'doctor: required checks' 'pass' "all required pass (warn=$warn_count)"
  elif [[ "$fail_count" == '0' ]]; then
    # Required-warn items are operator setup decisions (2FA recovery, DID,
    # pepper strength) not runtime breakage — surface as warn, not fail.
    record 'doctor: required checks' 'warn' "fail=0 but $required_fail required check(s) in warn state (warn total=$warn_count) — run \`memphis doctor\` for detail"
  else
    record 'doctor: required checks' 'fail' "fail=$fail_count, warn=$warn_count — run \`memphis doctor\` for detail"
  fi
else
  record 'doctor: required checks' 'fail' 'memphis doctor produced no output — CLI broken'
fi

# ── 6. Voice stack — Whisper :9000, Piper :5500 ──────────────────────
if curl -sS -m 3 http://127.0.0.1:9000/ >/dev/null 2>&1; then
  record 'voice: STT (whisper :9000)' 'pass' 'reachable'
else
  record 'voice: STT (whisper :9000)' 'warn' 'not running — voice STT will fall back to cloud or fail (run faster-whisper if needed)'
fi
if curl -sS -m 3 http://127.0.0.1:5500/ >/dev/null 2>&1; then
  record 'voice: TTS (piper :5500)' 'pass' 'reachable'
else
  record 'voice: TTS (piper :5500)' 'warn' 'not running — voice TTS will fall back to cloud or fail (run Piper if needed)'
fi

# ── 7. Provider key health (Brave / OpenAI / MiniMax) ────────────────
if memphis brave status --json 2>/dev/null | grep -q '"configured":\s*true'; then
  record 'provider: Brave Search key' 'pass' 'BRAVE_API_KEY resolved + reachable'
elif [[ -n "${BRAVE_API_KEY:-}" ]]; then
  record 'provider: Brave Search key' 'warn' 'env set but probe failed — run `memphis brave status` for detail'
else
  record 'provider: Brave Search key' 'pass' 'unset (memphis_web_search via DuckDuckGo is the no-key fallback)'
fi
if [[ -n "${OPENAI_COMPATIBLE_API_KEY:-}" && "${OPENAI_COMPATIBLE_API_KEY}" != VAULT:* ]]; then
  record 'provider: OpenAI key' 'pass' 'OPENAI_COMPATIBLE_API_KEY resolved'
elif [[ "${OPENAI_COMPATIBLE_API_KEY:-}" == VAULT:* ]]; then
  record 'provider: OpenAI key' 'fail' "env still holds ${OPENAI_COMPATIBLE_API_KEY} — vault didn't resolve"
else
  record 'provider: OpenAI key' 'pass' 'unset (other providers — ollama / minimax / anthropic — still work)'
fi
if [[ -n "${MINIMAX_API_KEY:-}" && "${MINIMAX_API_KEY}" != VAULT:* ]]; then
  record 'provider: MiniMax key' 'pass' 'resolved'
elif [[ "${MINIMAX_API_KEY:-}" == VAULT:* ]]; then
  record 'provider: MiniMax key' 'fail' 'vault did not resolve MINIMAX_API_KEY'
else
  record 'provider: MiniMax key' 'warn' 'unset — runtime falls back to ollama'
fi

# ── 8. HTTP gateway — listening on configured port ──────────────────
port="${PORT:-3100}"
if curl -sS -m 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1 || \
   curl -sS -m 3 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
  record "http: gateway :$port" 'pass' 'reachable'
else
  record "http: gateway :$port" 'warn' "not reachable on 127.0.0.1:$port — channel-only operator OK to ignore"
fi

# ── summary ───────────────────────────────────────────────────────────
if [[ $JSON_OUTPUT -eq 1 ]]; then
  printf '{'
  printf '"ok":%s,' "$([ $TOTAL_FAILS -eq 0 ] && echo true || echo false)"
  printf '"fails":%d,' "$TOTAL_FAILS"
  printf '"warns":%d,' "$TOTAL_WARNS"
  printf '"checks":['
  for i in "${!CHECKS_NAME[@]}"; do
    [[ $i -gt 0 ]] && printf ','
    printf '{"name":"%s","level":"%s","detail":"%s"}' \
      "${CHECKS_NAME[i]//\"/\\\"}" "${CHECKS_LEVEL[i]}" "${CHECKS_DETAIL[i]//\"/\\\"}"
  done
  printf ']}\n'
else
  printf '\n'
  if [[ $TOTAL_FAILS -gt 0 ]]; then
    printf '%s%s✗ FAIL%s — %d failure(s), %d warning(s)\n' "$BOLD" "$RED" "$RESET" "$TOTAL_FAILS" "$TOTAL_WARNS"
    printf '   investigate failures above before going live\n\n'
  elif [[ $TOTAL_WARNS -gt 0 ]]; then
    printf '%s%s⚠ READY (with warnings)%s — %d warning(s)\n' "$BOLD" "$YELLOW" "$RESET" "$TOTAL_WARNS"
    printf '   warnings are non-blocking but worth a glance\n\n'
  else
    printf '%s%s✓ READY%s — all probes green\n\n' "$BOLD" "$GREEN" "$RESET"
  fi
fi

exit $([ $TOTAL_FAILS -eq 0 ] && echo 0 || echo 1)
