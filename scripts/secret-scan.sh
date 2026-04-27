#!/usr/bin/env bash
set -euo pipefail

# Lightweight grep-based baseline (can be replaced by gitleaks/trufflehog later)
#
# Coverage matrix (issue #274):
#   - AKIA…       AWS access key id
#   - AIza…       GCP API key
#   - xox[baprs]- Slack tokens
#   - ghp_…       GitHub personal access token
#   - sk-ant-…    Anthropic API key
#   - sk-proj-…   OpenAI project key (modern format)
#   - sk-…        OpenAI / Mistral / generic sk-prefixed keys (lower-bound 32 chars
#                 to avoid matching `sk-` in unrelated text like CSS selectors)
#   - sk_live_…   Stripe live secret key
#   - sk_test_…   Stripe test secret key
#   - rk_live_…   Stripe live restricted key
#   - PEM private keys
#   - api_key="…" generic high-entropy assignment
PATTERN='(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|sk-ant-[A-Za-z0-9_\-]{20,}|sk-proj-[A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9_\-]{32,}|sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|api[_-]?key\s*[:=]\s*["\x27][A-Za-z0-9_\-]{16,})'

# Exclude data directory (contains npm documentation embeddings, not real secrets)
if grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=data --exclude='package-lock.json' "$PATTERN" .; then
  echo "[secret-scan] Potential secret detected." >&2
  exit 1
fi

echo "[secret-scan] OK"
