#!/usr/bin/env bash
set -euo pipefail

# cargo audit gate — the Rust dependency CVE scan, with one implementation.
#
# WHY THIS IS A SCRIPT AND NOT INLINE YAML
# ---------------------------------------
# `scripts/rust-core-safety-check.sh` ran `cargo audit`, and no workflow
# invoked that script. Measured 2026-11-10: grep over
# `.github/workflows/` returned no reference, and `npm run
# ops:rust-core:safety` was a command nobody ran. The audit called it:
# "cargo audit: the script exists, no workflow invokes it".
#
# "Exists but is never called" is the third option, and it was the one
# in force. The same reasoning as `scripts/dep-audit.sh`: the allowlist
# and the policy live in ONE file, so an entry cannot exist for the
# nightly caller and not for CI.
#
# WHY A SCRIPT AND NOT THE OFFICIAL ACTION
# -----------------------------------------
# `rustsec/audit-check` is the obvious way to run this in CI, and it is
# the wrong one here: its configuration is a list of advisory IDs in
# YAML, which would be a SECOND place where an accepted advisory can be
# written down. This file is that place.
#
# CONTRACT
#   any vulnerability whose advisory ID is not in ALLOWED_ADVISORIES
#   -> fails the gate.
#
# Each allowlist entry must be a line of the form
#   RUSTSEC-YYYY-NNNN   <why it is accepted, and when it is removed>
# A bare ID is rejected by the script below: an accepted advisory with
# no reason is how an exception list becomes permanent.
#
# Usage: bash scripts/cargo-audit-check.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v cargo-audit >/dev/null 2>&1; then
  echo "[cargo-audit] cargo-audit is not installed."
  echo "[cargo-audit] Install it with: cargo install cargo-audit --locked"
  echo "[cargo-audit] A missing scanner is not a clean tree."
  exit 127
fi

# --- allowlist -------------------------------------------------------------
# Empty today. Measured 2026-11-10 with cargo-audit 0.23.0 against
# Cargo.lock at 4750 commits of history: seven advisories, all in
# transitive dependencies, all fixed by patch-level updates plus one
# rusqlite bump (0.32 -> 0.41, which is what carries the patched
# SQLite 3.54.1 into the bundled build). The list is here so that the
# NEXT advisory has an obvious, documented place to go — with a reason,
# or it does not go there at all.
ALLOWED_ADVISORIES=""

# Every entry must carry a reason. `grep -v '^#'` drops the comments,
# and a line without a tab-separated reason fails the check below.
entries="$(printf '%s\n' "$ALLOWED_ADVISORIES" | grep -v '^[[:space:]]*$' || true)"

if [ -n "$entries" ]; then
  while IFS= read -r entry; do
    case "$entry" in
      RUSTSEC-*-*[!\t]*|*)
        if ! printf '%s' "$entry" | grep -qP '\t\S'; then
          echo "[cargo-audit] BLOCK: allowlist entry without a reason: $entry" >&2
          echo "[cargo-audit] Format: RUSTSEC-YYYY-NNNN<TAB>why it is accepted" >&2
          exit 1
        fi
        ;;
      *)
        echo "[cargo-audit] BLOCK: malformed allowlist entry: $entry" >&2
        exit 1
        ;;
    esac
  done <<<"$entries"
fi

# --- run -------------------------------------------------------------------
audit_json="$(cargo audit --json 2>/dev/null || true)"

if [ -z "$audit_json" ]; then
  echo "[cargo-audit] cargo audit produced no output — treating as failure." >&2
  echo "[cargo-audit] A silent audit is indistinguishable from a passing one." >&2
  exit 1
fi

vulns="$(printf '%s' "$audit_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR")
    sys.exit(0)
vulns = data.get("vulnerabilities", {})
if isinstance(vulns, dict):
    vulns = vulns.get("list", [])
for entry in vulns:
    advisory = entry.get("advisory", {})
    package = entry.get("package", {})
    print("\t".join([
        str(advisory.get("id", "?")),
        str(package.get("name", "?")),
        str(package.get("version", "?")),
        str(advisory.get("title", "")).replace("\t", " "),
    ]))
')"

if [ "$vulns" = "PARSE_ERROR" ]; then
  echo "[cargo-audit] could not parse the cargo audit report — treating as failure." >&2
  exit 1
fi

if [ -z "$vulns" ]; then
  echo "[cargo-audit] OK — no vulnerabilities in Cargo.lock"
  exit 0
fi

status=0
while IFS=$'\t' read -r id name version title; do
  [ -z "$id" ] && continue
  if printf '%s\n' "$entries" | grep -q "^${id}	"; then
    echo "[cargo-audit] ALLOWED ${id} (${name} ${version}): ${title}"
    continue
  fi
  echo "[cargo-audit] VULNERABILITY ${id}: ${name} ${version} — ${title}" >&2
  status=1
done <<<"$vulns"

if [ "$status" != "0" ]; then
  echo "[cargo-audit] BLOCK: an advisory is not in the allowlist of scripts/cargo-audit-check.sh." >&2
  echo "[cargo-audit] Fix the dependency, or record the advisory there WITH a reason." >&2
fi

exit "$status"
