#!/usr/bin/env bash
set -euo pipefail

# default-secret-scan.sh — a credential may not have a default.
#
# WHY THIS EXISTS
# ---------------
# On 2026-10-09 the operator asked what the consolidation work would earn, and
# answering it required reading live traffic numbers. Doing so proved that
# `api/stats.php` and `api/cron-cleanup.php` both authenticated with:
#
#     $token = getenv('MEMPHIS_STATS_TOKEN');
#     if (!is_string($token) || $token === '') {
#         $token = 'memphis-local-stats-2026';
#     }
#
# That literal was the credential. It was committed in two commits, it was one
# string away from the public repository, and `curl -H "X-Stats-Token:
# memphis-local-stats-2026" https://memphis-v5.pl/api/stats.php` returned HTTP 200
# with real visitor, download and funnel numbers. The same string unlocked a
# script running `DELETE FROM visitors, events, downloads`.
#
# WHY secret-scan.sh DID NOT CATCH IT
# ----------------------------------
# secret-scan.sh matches credential *prefixes*: ghp_, sk-ant-, AKIA, PEM,
# api_key="...". A project-local shared secret matches none of those arms, so
# the scan reported OK on a tree where the key was committed. Same shape as the
# PII gap 68780a7 left — a scan answers the question it was written for, and the
# question nobody asked goes unanswered.
#
# WHAT IS FLAGGED
# ---------------
# A quoted literal assigned to a token-shaped variable, anywhere in a tracked
# file, in any of the languages this repo ships:
#
#     $token = 'literal';            php
#     const TOKEN = "literal";       ts/js
#     process.env.TOKEN ?? 'lit';   ts/js
#     process.env.TOKEN || 'lit';   ts/js
#     $expected = "literal";         php
#
# WHY NOT EVERY QUOTED STRING
# ---------------------------
# A scan that flags every literal goes red on its own header, gets disabled, and
# then misses the next real one. This matches an ASSIGNMENT TO A CREDENTIAL-SHAPED
# NAME, which is the defect. Environment-variable names and HTTP header names are
# excluded — `getenv('MEMPHIS_STATS_TOKEN')` names the variable, it is not a
# value.
#
# Portability: POSIX ERE only. macOS BSD grep rejects GNU-only constructs
# (\s, \- inside brackets, \x27) — the exact bug secret-scan.sh documents, where
# the regex fails, xargs swallows it, `|| true` keeps the script alive, and the
# scan reports a clean tree while checking nothing.

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[default-secret-scan] not a git repository - nothing tracked to scan"
  exit 0
fi

SELF="scripts/default-secret-scan.sh"

# WHY tests/ IS EXEMPT -- MEASURED, NOT ASSUMED
# ---------------------------------------------
# The first run of this gate reported 13 "hard-coded credentials" in tracked
# files. All 13 were test fixtures:
#
#   const TOKEN = '123456:AArealoperator';        x10  mcp-send-*.test.ts
#   const PASSPHRASE = 'my-secret-passphrase-123';     self-modify-passphrase
#   const PASSPHRASE = 'test-passphrase-123';           vault-init-refuse-nonempty
#   $token = 'memphis-local-stats-2026';                 this file's own header
#
# Verified the Telegram one is dead rather than assuming it: the Bot API answers
# 401 Unauthorized for bot123456:AArealoperator. It is a fixture shaped like a
# credential, not a credential.
#
# So the gate skips tests/ rather than carrying an exception list. An exception
# list is a place where the next real leak gets whitelisted; a path exclusion is
# a statement about what the directory is FOR. Tests assert behaviour and must
# be able to name a secret-shaped string.
#
# The cost is real and worth stating: a secret genuinely committed inside a test
# is now outside this gate's reach. tests/unit/pii-scan.test.ts and
# secret-scan.sh still cover that directory, and the api/ contract test reads
# the shipped endpoints directly.

# Credential-shaped variable NAMES. `auth` was tried and removed: it matched
# MEMPHIS_HTTP_CORS_ORIGIN's neighbourhood and told us nothing. `key` alone was
# removed too -- it matches `api_key` (good) but also `key = record.key` (bad),
# and a gate that cannot separate those is a gate that gets deleted.
#
# The list is names that hold a secret and nothing else.
VAR='(token|secret|passwd|password|passphrase|api_key|apikey|credential)'
VAR_PHP='(token|secret|passwd|password|passphrase|api_key|apikey|credential|expected|given)'
VAR_JS='(TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|APISECRET|APIKEY|CREDENTIAL)'

TMPHITS="$(mktemp)"
trap 'rm -f "$TMPHITS"' EXIT
scanned=0

while IFS= read -r -d '' f; do
  [ "$f" = "$SELF" ] && continue
  [ -f "$f" ] || continue
  case "$f" in
    tests/*|*.test.ts|*.test.mts|*.test.js|*.test.mjs) continue ;;
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.mp4|*.webm|*.woff|*.woff2|*.ttf|*.pdf|*.zip) continue ;;
  esac
  scanned=$((scanned + 1))

  # 1. direct assignment:  $token = 'literal';   const TOKEN = "literal";
  # php: $token = 'literal';
  m="$(grep -nE "\\\$$VAR_PHP[[:space:]]*=[[:space:]]*['\"][^'\"]{4,}['\"]" "$f" 2>/dev/null || true)"
  # js/ts: const TOKEN = "literal";  — uppercase only, so `key = record.key` is safe
  [ -z "$m" ] && m="$(grep -nE "(var|let|const)[[:space:]]+$VAR_JS[[:space:]]*=[[:space:]]*['\"][^'\"]{4,}['\"]" "$f" 2>/dev/null || true)"
  if [ -n "$m" ]; then
    {
      echo "[default-secret-scan] HARD-CODED CREDENTIAL in $f:"
      printf '%s\n' "$m" | sed 's/^/    /'
    } >>"$TMPHITS"
    continue
  fi

  # 2. env fallback:  process.env.TOKEN ?? 'literal';  || 'literal';  ?: 'literal';
  # The env read AND the literal must be on the SAME line, and the env var
  # must itself be credential-shaped. An earlier version matched them
  # independently and reported `process.env.PUBLIC_CHAT_PORT || '9100'` as a
  # credential default — a port number is not a secret, and 14 files went red
  # for it. A gate that blocks correct code gets switched off, and a switched-off
  # gate catches the next real one either.
  m="$(grep -nE "(process\.env\.$VAR_JS|getenv\(['\"]$VAR_PHP['\"]\))[[:space:]]*(\?\?|\|\||\?:)[[:space:]]*['\"][^'\"]{4,}['\"]" "$f" 2>/dev/null || true)"
  if [ -n "$m" ]; then
    if [ -n "$m" ]; then
      {
        echo "[default-secret-scan] CREDENTIAL WITH A DEFAULT in $f:"
        printf '%s\n' "$m" | sed 's/^/    /'
        echo "    A default that is a credential is not a fallback, it is a published key."
        echo "    Unconfigured must mean closed (503), not open."
        echo "    See sites/memphis-v5/api/_boot.php::require_token."
      } >>"$TMPHITS"
    fi
  fi
done < <(git ls-files -z 2>/dev/null || printf '')

if [ -s "$TMPHITS" ]; then
  cat "$TMPHITS" >&2
  echo "[default-secret-scan] BLOCK: a credential cannot have a default." >&2
  echo "[default-secret-scan] Read it from the environment and refuse when unset." >&2
  exit 1
fi

echo "[default-secret-scan] OK ($scanned text files, no credential defaults)"