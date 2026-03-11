#!/usr/bin/env bash
set -euo pipefail

# Lightweight grep-based baseline (can be replaced by gitleaks/trufflehog later)
PATTERN='(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|api[_-]?key\s*[:=]\s*["\x27]?[A-Za-z0-9_\-]{16,})'

# Exclude data directory (contains npm documentation embeddings, not real secrets)
if grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=data --exclude='package-lock.json' "$PATTERN" .; then
  echo "[secret-scan] Potential secret detected." >&2
  exit 1
fi

echo "[secret-scan] OK"
