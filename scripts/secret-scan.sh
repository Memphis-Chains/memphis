#!/usr/bin/env bash
set -euo pipefail

# Lightweight grep-based baseline (can be replaced by gitleaks/trufflehog later)
#
# Pattern coverage (issue #274 expanded the set 2026-04-30 to add prefixes
# common in Memphis's operational environment that the original v1.5.0
# scan missed):
#
#   AKIA[0-9A-Z]{16}                            AWS access-key-id
#   AIza[0-9A-Za-z\-_]{35}                      GCP API key
#   xox[baprs]-…                                Slack tokens
#   ghp_[0-9A-Za-z]{36}                         GitHub PAT
#   sk-ant-[A-Za-z0-9\-_]{20,}                  Anthropic key (legacy "sk-ant-" form)
#   sk-(proj|test|live|None)-[A-Za-z0-9\-_]{20,}   OpenAI key (proj/test/live/None scopes)
#   (sk|rk)_(test|live)_[A-Za-z0-9]{24,}         Stripe secret/restricted keys
#   whsec_[A-Za-z0-9]{32,}                       Stripe webhook signing secrets
#   -----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----   PEM private key blocks
#   api[_-]?key\s*[:=]\s*["\x27]…                generic api_key="…" assignments (quoted to avoid fn-call false-positives)
#
# Note on Mistral: their public API keys carry no dedicated prefix — they
# look like opaque 32-character base64 strings, indistinguishable from
# many non-secrets. Adding a regex broad enough to catch them would
# false-positive on UUIDs, hashes, etc. Mistral keys ride the generic
# `api[_-]?key="…"` pattern instead. If a pattern emerges (e.g. Mistral
# ships scoped keys with a prefix), add it here.
PATTERN='(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|sk-ant-[A-Za-z0-9\-_]{20,}|sk-(proj|test|live|None)-[A-Za-z0-9\-_]{20,}|(sk|rk)_(test|live)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|api[_-]?key\s*[:=]\s*["\x27][A-Za-z0-9_\-]{16,})'

# Exclude:
#  - node_modules / .git / data / package-lock.json — uninteresting payloads
#  - tests/unit/secret-scan.test.ts — its fixtures are intentional sample
#    strings shaped like each credential family so the scan itself is
#    test-able. Without this exclusion the scan flags its own coverage
#    fixtures and exit 1's on every CI run.
if grep -RInE \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=data \
    --exclude='package-lock.json' \
    --exclude='secret-scan.test.ts' \
    "$PATTERN" .; then
  echo "[secret-scan] Potential secret detected." >&2
  exit 1
fi

echo "[secret-scan] OK"
