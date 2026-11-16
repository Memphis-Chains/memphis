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

# WHY tests/ IS NOT EXEMPT ANY MORE -- MEASURED, NOT ASSUMED
# ----------------------------------------------------------
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
# THE FIRST ANSWER WAS A PATH EXEMPTION, AND IT WAS WRONG
# -------------------------------------------------------
# Until 2026-11-16 this gate skipped `tests/*` and every `*.test.*` by path.
# The reasoning was sound — tests assert behaviour and must be able to name a
# secret-shaped string — but the exemption was by DIRECTORY, so a real secret
# committed inside a test file was outside this gate's reach. The runtime audit
# named it: "default-secret-scan: exempts tests/ and every *.test.* by path".
#
# THE ANSWER NOW: A POSITIVE RULE, BY VALUE
# -------------------------------------------
# Known fake values are allowlisted by value, in
# `scripts/default-secret-scan.allowlist`, each with the reason it is
# accepted and when it is removed. An entry without a reason is rejected by
# the scan above — the exception list cannot grow silently.
#
# MEASURED 2026-11-16, on this host, after the change:
#
#   * a planted `const TOKEN = 'ghp_AAAA...'` inside tests/unit/ -> BLOCKED.
#     (The first planting attempt reported OK, because the scan reads
#     `git ls-files` and the file was untracked. The falsifying probe needs
#     `git add -N` — a scan that reads the index sees the working tree only
#     for files the index knows about.)
#   * every fixture value in the allowlist -> accepted.
#   * removing one allowlist entry -> the fixture it covered is BLOCKED.
#
# The cost is now stated in the other direction: an exception list is a place
# where the next real leak gets whitelisted, so each entry carries its
# measurement and the condition under which it is removed. That is a
# statement about a VALUE, which is what can be measured; a path exemption
# was a statement about a DIRECTORY, which is what cannot be.

# Credential-shaped variable NAMES. `auth` was tried and removed: it matched
# MEMPHIS_HTTP_CORS_ORIGIN's neighbourhood and told us nothing. `key` alone was
# removed too -- it matches `api_key` (good) but also `key = record.key` (bad),
# and a gate that cannot separate those is a gate that gets deleted.
#
# The list is names that hold a secret and nothing else.
#
# `fromEnv` is here because of a real miss on 2026-10-09, not a guess. A second
# mutation of _boot.php assigned the literal to `$fromEnv` instead of
# `$expected`, the static contract test caught it — and the gate reported OK on
# 1533 files. A gate that matches on variable NAMES cannot see a variable
# someone named after where it came from. The lesson from MEMPHIS_ENV_PATH, one
# layer over: the scan stayed green because its pattern did not cover the real
# path, not because the path was clean.
VAR='(token|secret|passwd|password|passphrase|api_key|apikey|credential)'
# Prefixes matter: the measured gap was `$apiToken` passing while `$token` was
# caught. A secret variable is almost always <qualifier><noun> — apiToken,
# authToken, botToken, dbPassword. Listing only the nouns means a rename is
# enough to walk past the gate.
# Plural forms too: measured, `$userCredentials` passed while `$userCredential`
# was caught. English plurals are one letter and a rename is still a rename.
#
# KNOWN GAP, DELIBERATE: `$sessionKey`, `$encryptionKey` and friends are NOT in
# this list. `key` alone matches `key = record.key` in ordinary data code, and a
# gate that blocks that is a gate that gets switched off. Cost of the gap: a
# credential named `*Key` and nothing else is not caught here. `secret-scan.sh`
# still catches it if the value has a machine-credential prefix, and the
# reviewed api/ contract test reads that tree directly. Widening to `keys?` is a
# one-word change the moment a false-positive baseline exists to justify it.
VAR_PHP='(tokens?|secrets?|passw?d|password|passphrase|api_?keys?|credentials?|expected|given|fromenv|shared_?secrets?|[a-z_]*(tokens?|secrets?|passw?d|password|passphrase|credentials?))'
VAR_JS='(TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|APISECRET|APIKEY|CREDENTIAL)'

# The allowlist: known fixture values, accepted BY VALUE.
#
# WHY A VALUE LIST AND NOT A PATH EXEMPTION
# ------------------------------------------
# Until 2026-11-10 this gate skipped the whole test directory and every
# test-shaped file by path. The reasoning was sound — tests assert
# behaviour and must be able to name a secret-shaped string — but the
# exemption was by DIRECTORY, so a real secret committed inside a test
# file was outside the gate's reach. The runtime audit named it.
#
# An entry without a reason is rejected: an accepted value with no
# stated reason is how an exception list becomes permanent.
ALLOWLIST_FILE="${MEMPHIS_SECRET_SCAN_ALLOWLIST:-scripts/default-secret-scan.allowlist}"
ALLOWLIST_VALUES="$(mktemp)"
if [ -f "$ALLOWLIST_FILE" ]; then
  # An entry is a VALUE, a tab, and a REASON. All three, or the entry is
  # not an entry.
  #
  # Measured 2026-11-16: this loop did not exist, and `cut -f1` took the
  # first field of every line — so a line with no tab was accepted as a
  # value with an empty reason. The allowlist file's own header promises
  # "a value without a reason is rejected by the scan", and the code did
  # not reject it. An exception list where the exception can be added
  # without saying why is an exception list that grows.
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    value="${line%%	*}"
    reason="${line#*	}"
    if [ "$line" = "$value" ]; then
      echo "[default-secret-scan] BLOCK: allowlist entry without a reason: $value" >&2
      echo "[default-secret-scan] Format: <value><TAB><why it is accepted, and when it is removed>" >&2
      exit 1
    fi
    if [ -z "$reason" ]; then
      echo "[default-secret-scan] BLOCK: allowlist entry with an empty reason: $value" >&2
      exit 1
    fi
    printf '%s\n' "$value" >>"$ALLOWLIST_VALUES"
  done <"$ALLOWLIST_FILE"
else
  : >"$ALLOWLIST_VALUES"
fi

TMPHITS="$(mktemp)"
trap 'rm -f "$TMPHITS" "$ALLOWLIST_VALUES"' EXIT
scanned=0

while IFS= read -r -d '' f; do
  [ "$f" = "$SELF" ] && continue
  [ -f "$f" ] || continue
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.mp4|*.webm|*.woff|*.woff2|*.ttf|*.pdf|*.zip) continue ;;
  esac
  scanned=$((scanned + 1))

  # 1. direct assignment:  $token = 'literal';   const TOKEN = "literal";
  # php: $token = 'literal';
  # WHY [\$] AND NOT \$  -- the gate was silently blind for its own bug
  # ---------------------------------------------------------------
  # `\$$VAR_PHP` does NOT expand to backslash-dollar + alternation. Inside double
  # quotes bash turns `\$` into a plain `$`, so grep received the pattern
  # `$(token|secret|expected|given)[...]=['"]...` and searched for a literal
  # `$(` sequence that appears in no PHP file. It reported OK on 1533 files
  # while a hard-coded credential sat in _boot.php -- green because the pattern
  # never matched anything, not because the tree was clean.
  #
  # `[\$]` is a bracket expression: bash expands $VAR_PHP, the brackets reach
  # grep as [\$], and ERE reads that as a literal dollar. Verified against a
  # fixture before this line was trusted.
  # -i: php variables are camelCase ($fromEnv, $apiToken), so the alternation
  # must be case-insensitive. Measured: without it, a literal assigned to
  # $fromEnv passed the gate while the same literal on $expected was caught.
  m="$(grep -niE "[\$]$VAR_PHP[[:space:]]*=[[:space:]]*['\"][^'\"]{4,}['\"]" "$f" 2>/dev/null || true)"
  # js/ts: const TOKEN = "literal";  — uppercase only, so `key = record.key` is safe
  [ -z "$m" ] && m="$(grep -nE "(var|let|const)[[:space:]]+$VAR_JS[[:space:]]*=[[:space:]]*['\"][^'\"]{4,}['\"]" "$f" 2>/dev/null || true)"
  if [ -n "$m" ]; then
    # A hit line is `88:const TOKEN = 'value';` — the allowlist holds the
    # VALUE, so the line is dropped when it contains an allowed value.
    # Matching the whole line would never match anything.
    m="$(printf '%s\n' "$m" | while IFS= read -r line; do
      if [ -z "$line" ]; then continue; fi
      allowed=1
      while IFS= read -r value; do
        [ -z "$value" ] && continue
        if [[ "$line" == *"$value"* ]]; then
          allowed=0
          break
        fi
      done <"$ALLOWLIST_VALUES"
      if [ "$allowed" -eq 1 ]; then
        printf '%s\n' "$line"
      fi
    done)"
  fi
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