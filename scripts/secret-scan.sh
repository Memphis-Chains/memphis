#!/usr/bin/env bash
set -euo pipefail

# Lightweight grep-based baseline (can be replaced by gitleaks/trufflehog later)
#
# Pattern coverage (issue #274 expanded the set 2026-04-30 to add prefixes
# common in Memphis's operational environment that the original v1.5.0
# scan missed):
#
#   AKIA[0-9A-Z]{16}                            AWS access-key-id
#   AIza[0-9A-Za-z_-]{35}                       GCP API key
#   xox[baprs]-…                                Slack tokens
#   ghp_[0-9A-Za-z]{36}                         GitHub PAT
#   sk-ant-[A-Za-z0-9_-]{20,}                   Anthropic key (legacy "sk-ant-" form)
#   sk-(admin|proj|test|live|None)-[A-Za-z0-9_-]{20,}   OpenAI key (proj/test/live/None scopes)
#   (sk|rk)_(test|live)_[A-Za-z0-9]{24,}         Stripe secret/restricted keys
#   whsec_[A-Za-z0-9]{32,}                       Stripe webhook signing secrets
#   -----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----   PEM private key blocks
#   api[_-]?key[[:space:]]*[:=][[:space:]]*["']…  generic api_key="…" assignments (quoted to avoid fn-call false-positives)
#
# Note on Mistral: their public API keys carry no dedicated prefix — they
# look like opaque 32-character base64 strings, indistinguishable from
# many non-secrets. Adding a regex broad enough to catch them would
# false-positive on UUIDs, hashes, etc. Mistral keys ride the generic
# `api[_-]?key="…"` pattern instead. If a pattern emerges (e.g. Mistral
# ships scoped keys with a prefix), add it here.
#
# Portability note (S11-2 fix, 2026-05-02): the regex is POSIX ERE,
# not GNU-extended ERE. macOS BSD grep silently rejects three GNU-only
# constructs we used to ship:
#   * `\s`  (Perl shorthand for whitespace) — replaced with `[[:space:]]`
#   * `\-`  inside `[A-Za-z0-9\-_]` (BSD treats `\` as literal in classes,
#           yielding `[A-Za-z0-9\-_]` matching `\` not the intended hyphen)
#           — replaced with hyphen at the END of the class, where it's
#           always literal in both BSD and GNU
#   * `\x27` (hex single-quote escape) — not a POSIX ERE feature
#           — replaced with a literal single quote, injected via shell
#           variable assembly so this script remains valid bash regardless
#           of how it's quoted
# With those constructs in place, BSD grep silently fails the whole
# pattern (returns 0 matches), `xargs` with `2>/dev/null` swallows the
# error, the `|| true` keeps the script alive, and `matches` ends up
# empty so we falsely claim OK. This script appeared to work on Linux
# (GNU grep) only — every macOS CI run reported `secret-scan.test.ts`
# 14/15 failing.
SQ="'"  # single quote, injected as variable so the PATTERN string can
        # safely contain it under outer single-quote shell quoting.
PATTERN='(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(admin|proj|test|live|None)-[A-Za-z0-9_-]{20,}|(sk|rk)_(test|live)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|api[_-]?key[[:space:]]*[:=][[:space:]]*["'"$SQ"'][A-Za-z0-9_-]{16,})'

# Exclude:
#  - node_modules / .git / data / package-lock.json — uninteresting payloads
#  - tests/unit/secret-scan.test.ts — its fixtures are intentional sample
#    strings shaped like each credential family so the scan itself is
#    test-able. The exclusion targets the EXACT path, not just a basename
#    glob, so a future file at any other location with the same basename
#    (e.g. tests/security/secret-scan.test.ts) would still get scanned.
#    Codex P2 (PR #376) caught the basename-only blind spot — fix uses
#    `find -path !=` for path-aware filtering.
EXCLUDED_PATH='./tests/unit/secret-scan.test.ts'
# `find -L` follows symlinks so secrets present via a symlinked path
# still get scanned — preserves the prior `grep -R --dereference-recursive`
# behavior (Codex round 4 P1 caught the symlink-bypass regression).
# `-name` on directory predicates so nested node_modules / .git / data
# at any depth are pruned (Codex round 3 P2: `-path './node_modules'`
# only matched at the tree root).
matches="$(
  find -L . \
    \( -type d \( -name node_modules -o -name .git -o -name data \) \) -prune -o \
    -type f \
    ! -name 'package-lock.json' \
    ! -path "$EXCLUDED_PATH" \
    -print0 \
  | xargs -0 grep -InE "$PATTERN" 2>/dev/null \
  || true
)"
if [ -n "$matches" ]; then
  printf '%s\n' "$matches"
  echo "[secret-scan] Potential secret detected." >&2
  exit 1
fi

echo "[secret-scan] OK"
