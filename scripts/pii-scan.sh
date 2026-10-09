#!/usr/bin/env bash
set -euo pipefail

# Operator PII scan — the guard that 68780a7 was missing.
#
# WHY THIS EXISTS
# ---------------
# scripts/secret-scan.sh answers a different question: "is a machine
# credential committed?" It matches credential *prefixes* (ghp_, sk-ant-,
# AKIA, PEM headers, api_key="..."). An account identifier matches none of
# those arms, so the scan reported `OK` on a tree that carried one.
# Measured: after 68780a7 ("security scrub") the operator's real Telegram
# chat id was live on the public default branch, in ten test fixtures added
# three days later by ed2f1f4.
#
# WHY FILENAME MATCHING WAS NOT ENOUGH (the 2026-09-29 lesson)
# ----------------------------------------------------------
# The scrub prevented recurrence with `.gitignore` entries:
#
#     private-work/
#     notes/<client>-*.md
#
# Both are *filename* patterns. The data came straight back under a
# different name -- the same chat id reappeared in
# `tests/unit/mcp-send-*.test.ts`, which no gitignore line covers. A guard
# keyed on filenames cannot catch a value arriving in a new file, and
# gitignore does nothing for files already in the index. This scan keys on
# VALUES, so it catches the leak in whatever file it appears in.
#
# SCOPE: TRACKED FILES ONLY
# -------------------------
# The first draft walked the working tree with `find` and reported 40+
# hits. Almost all were gitignored and untracked: `.env.bak-pre-*` copies
# and `work/minimax-evidence-pack/`, which held a full client dossier.
# Scary, but never committed, so they cannot leak through the repo.
# Reporting them would train the operator to ignore this script. It reads
# `git ls-files` instead -- the exact set that reaches GitHub.
#
# `work/` and `.env.bak-*` deserve their own audit (a plaintext .env backup
# on disk is its own risk), but that is a different question from "did we
# commit private data", and conflating the two makes this gate useless.
#
# TWO TIERS, BECAUSE A RED GATE GETS DISABLED
# -------------------------------------------
#   BLOCK (exit 1)  the operator's own account identifiers. These are
#                   unambiguous, and this exact class already regressed once.
#   ADVISORY (exit 0, listed on stderr) a named third party's business name
#                   and shop domain. These are genuinely in the public tree
#                   today, across ~34 files -- but several are load-bearing:
#                   scripts/dashboard-api.py and scripts/seed-dashboard-db.py
#                   probe that domain as operational configuration, and
#                   docs/pkd/ is the operator's own tax working notes.
#                   Rewriting them is an operator decision, not a drive-by.
#
# Demoting the advisory tier to a hard fail before that cleanup exists would
# make this script permanently red, and a permanently-red script is one
# nobody reads. Run with --strict to fail on both while working on it.
#
# Portability: POSIX ERE only. macOS BSD grep silently rejects GNU-only
# constructs (`\s`, `\-` inside bracket expressions, `\x27`) -- the exact
# bug secret-scan.sh documents, where the regex fails, `xargs` swallows it,
# `|| true` keeps the script alive, and the scan reports a clean tree while
# checking nothing. Do not introduce them here.

STRICT=0
if [ "${1:-}" = "--strict" ]; then
  STRICT=1
fi

# Operator's own account identifiers. Never committed, no exceptions.
#
# Assembled at runtime rather than written as a literal. A scanner that
# carries the identifier it forbids cannot be run against a repository whose
# history is being scrubbed of that identifier: git-filter-repo rewrites every
# blob, including this file, so the literal would be rewritten too and the
# gate would stop matching the value it exists to catch. The test file
# already builds its fixture the same way
# (tests/unit/pii-scan.test.ts, `['131','603','3647'].join('')`).
OPERATOR_PII="$(printf '%s%s%s' '131' '603' '3647')"

# Named third parties: people the operator works for, not the operator.
# Advisory by default -- see "TWO TIERS" above.
#
# `dsmx` and `dsmxshop` are listed separately on purpose. They are the
# same client's brand and shop domain, but they appear in different
# places, and one pattern does not cover both: `dsmxshop` never matched
# the `dsmx-usa-assets/` directory, so the gate reported OK while 3.8 MB
# of that client's promo video sat on the public default branch.
CLIENT_PII='dsmxshop|dsmx|Szczepan'

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[pii-scan] not a git repository - nothing tracked to scan" >&2
  exit 0
fi

# Tracked files, minus this scanner (its own header names the patterns it
# looks for, so it would otherwise always flag itself).
tracked() {
  git ls-files -z | xargs -0 -I{} printf '%s\0' {} \
    | while IFS= read -r -d '' f; do
        [ "$f" = "scripts/pii-scan.sh" ] || printf '%s\0' "$f"
      done
}

hits() {
  tracked | xargs -0 grep -IlE "$1" 2>/dev/null || true
}

# Content-only scanning is half a gate. Measured on 2026-10-06:
# `dsmx-usa-assets/dsmx-usa-promo-30s-canam-polaris.mp4` — 3.8 MB of a
# named client's promo video — sat on the public default branch for seven
# months while this script reported OK, because the identifier lived in
# the *filename* and the scanner only ever read file bodies.
#
# The 2026-09-29 lesson was that path-matching guards fail when a value
# arrives in a new file. The complementary failure is that content
# matching fails when the value arrives in a new *name*. Both are needed.
path_hits() {
  tracked | tr '\0' '\n' | grep -IE "$1" || true
}

# WHY FILE TYPES ARE A SEPARATE ARM
# ----------------------------------
# Measured 2026-10-09: `sites/memphis-v5/docs/internal/.htpasswd` was staged
# on a PUBLIC repo carrying `memphis:<password-hash>`. Nothing caught it, and
# the reason is structural rather than a missing regex:
#
#   - the value scan looks for account identifiers, and a password hash is
#     not an account identifier
#   - the path scan looks for those identifiers in names, and `.htpasswd` is
#     an innocuous name
#   - secret-scan.sh matches credential *content* (PEM headers, ghp_, AKIA),
#     and an htpasswd line has none of those headers
#
# So the leak passed every arm that existed. It is not that the regex was
# too weak; it is that the question "is this file type credential material
# by nature" was never asked.
#
# File *type* is a different axis from file *value* and file *name*. The
# 2026-09-29 lesson needed a value arm; the 2026-10-06 lesson needed a name
# arm; this is the third: a guard keyed on names cannot know that
# `.htpasswd` is a password database, and a guard keyed on values cannot
# know it either, because the value was never the operator's identifier.
#
# Tier: BLOCK. A private key or a password hash on a public branch is never
# a deliberate trade-off like the client-name advisory — it is a leak whose
# only question is why it was committed. Exceptions are declared explicitly
# below rather than discovered later.
SECRET_FILE_TYPES='\.(htpasswd|htdigest|pem|key|p12|pfx|jks|keystore|ppk|kdbx|age|gnupg|kwallet|tfstate)$'

# Paths exempt from the file-type arm. Empty today; the escape hatch exists
# so a legitimate future addition is a visible, reviewed line rather than a
# silently weakened pattern.
SECRET_FILE_TYPE_EXEMPT=''

# `grep -vE ''` matches every line and therefore filters ALL of them out —
# an empty exemption list silently disabled this entire arm. Measured while
# writing the tests: the pattern was correct and the filter ate the result.
# `a^` can never match, so an empty list becomes a no-op instead of a
# universal reject.
if [ -n "$SECRET_FILE_TYPE_EXEMPT" ]; then
  secret_type_files="$(path_hits "$SECRET_FILE_TYPES" \
    | grep -vE "$SECRET_FILE_TYPE_EXEMPT" || true)"
else
  secret_type_files="$(path_hits "$SECRET_FILE_TYPES")"
fi

operator_files="$(hits "$OPERATOR_PII")"
client_files="$(hits "$CLIENT_PII")"

# Paths are checked against the operator tier (an account id in a filename
# is as identifying as in a body) and the client tier (a business name in a
# directory name is as exposing as in prose).
operator_paths="$(path_hits "$OPERATOR_PII")"
client_paths="$(path_hits "$CLIENT_PII")"

operator_files="$(printf '%s\n%s' "$operator_files" "$operator_paths" | grep -v '^$' || true)"
client_files="$(printf '%s\n%s' "$client_files" "$client_paths" | grep -v '^$' || true)"

status=0

if [ -n "$secret_type_files" ]; then
  echo "[pii-scan] BLOCK: credential-material file type in tracked files:" >&2
  printf '%s\n' "$secret_type_files" | sed 's/^/[pii-scan]   /' >&2
  echo "[pii-scan] These file types are secret by nature regardless of content:" >&2
  echo "[pii-scan] a password hash has no identifying value to match on, and a" >&2
  echo "[pii-scan] private key carries no credential header to scan for." >&2
  echo "[pii-scan] Keep such material in the vault, not in the repository." >&2
  status=1
fi

if [ -n "$operator_files" ]; then
  echo "[pii-scan] BLOCK: operator account identifier in tracked files:" >&2
  printf '%s\n' "$operator_files" | sed 's/^/[pii-scan]   /' >&2
  echo "[pii-scan] Replace with a neutral fixture before pushing." >&2
  status=1
fi

if [ -n "$client_files" ]; then
  {
    echo "[pii-scan] ADVISORY: third-party identifiers in tracked files"
    printf '%s\n' "$client_files" | sed 's/^/[pii-scan]   /'
    echo "[pii-scan] Known open item. Some are operational config"
    echo "[pii-scan] (scripts/dashboard-*.py probe the domain), so removal is"
    echo "[pii-scan] an operator decision. Run with --strict to block on these."
  } >&2
  if [ "$STRICT" = "1" ]; then
    status=1
  fi
fi

if [ "$status" = "0" ] && [ -z "$client_files" ] && [ -z "$secret_type_files" ]; then
  echo "[pii-scan] OK"
elif [ "$status" = "0" ]; then
  echo "[pii-scan] OK (operator identifiers clean; advisory above)"
fi

exit "$status"