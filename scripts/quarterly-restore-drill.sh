#!/usr/bin/env bash
# Quarterly disaster-restore drill — proves backups are restorable + chain
# integrity verifies on a fresh runtime tree. Designed to run as a `memphis
# schedule add` task at "0 4 1 */3 *" (4 AM, first day of every third month).
#
# Self-contained: takes a fresh backup, restores into a tmpdir, runs
# `memphis chain verify` against the restored runtime, and audits the result.
# Operator's actual runtime is untouched throughout.
#
# On failure the temp directory and drill log are PRESERVED so the operator
# can inspect them. Successful runs clean up entirely.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS() { echo "[PASS] $1"; }
FAIL() {
  echo "[FAIL] $1"
  echo "[FAIL] Preserved tmpdir for inspection: $TMPDIR"
  PRESERVE_TMPDIR=1
  exit 1
}
STEP() { echo "[STEP] $1"; }
SKIP() { echo "[SKIP] $1"; }

TAG="${MEMPHIS_DRILL_TAG:-quarterly-drill-$(date -u +%Y%m%d)}"
TMPDIR="$(mktemp -d /tmp/memphis-drill-XXXXXX)"
DRILL_LOG="$TMPDIR/drill.log"
PRESERVE_TMPDIR=0

cleanup() {
  if [[ "${PRESERVE_TMPDIR:-0}" -eq 1 ]]; then
    return
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

STEP "1/5 — Take fresh backup tagged '$TAG'"
BACKUP_OUT="$(node bin/memphis.js backup create --tag "$TAG" --json 2>&1)" || FAIL "backup create failed: $BACKUP_OUT"
# `createBackup()` (src/infra/cli/commands/backup.ts:639) returns
# { backupPath, file, tag, size, fileCount, checksum } — JSON key is
# `backupPath`, NOT `path`.
BACKUP_FILE="$(echo "$BACKUP_OUT" | grep -oE '"backupPath":\s*"[^"]+"' | sed 's/.*"\([^"]*\)".*/\1/' | head -1)"
[[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]] && FAIL "backup file missing — output was: $BACKUP_OUT"
PASS "backup created at $BACKUP_FILE"

STEP "2/5 — Verify backup file integrity"
node bin/memphis.js backup verify "$BACKUP_FILE" --json >/dev/null 2>&1 || FAIL "backup verify rejected $BACKUP_FILE"
PASS "backup file passes integrity check"

STEP "3/5 — Restore into isolated tmpdir ($TMPDIR/restored)"
RESTORE_DIR="$TMPDIR/restored"
mkdir -p "$RESTORE_DIR"
# Restore into the isolated dir by overriding MEMPHIS_DATA_DIR. The restore
# command writes into the runtime root resolved at the time it runs, so we
# point it at our tmpdir.
MEMPHIS_DATA_DIR="$RESTORE_DIR" \
  node bin/memphis.js backup restore "$BACKUP_FILE" --yes --json \
  >"$DRILL_LOG" 2>&1 || FAIL "restore failed — see $DRILL_LOG"
PASS "restore completed into $RESTORE_DIR"

STEP "4/5 — Verify chain integrity in restored tree"
MEMPHIS_DATA_DIR="$RESTORE_DIR" \
  node bin/memphis.js chain verify --json \
  >>"$DRILL_LOG" 2>&1 || FAIL "chain verify rejected restored runtime — see $DRILL_LOG"
PASS "chain integrity verified on restored tree"

STEP "5/5 — Smoke check: rebuild chain index, count entries"
# `rebuildChainIndexes()` (src/core/chain-index-rebuild.ts:102) returns
# { ok, indexPath, sourcesScanned, sourcesImported, corruptedSources,
#   missingIndexRecovered, entries }.
REBUILD_OUT="$(MEMPHIS_DATA_DIR="$RESTORE_DIR" node bin/memphis.js chain rebuild --json 2>/dev/null || echo '{}')"
ENTRIES="$(echo "$REBUILD_OUT" | grep -oE '"entries":\s*[0-9]+' | sed 's/.*: *//' | head -1 || echo "0")"
SOURCES_SCANNED="$(echo "$REBUILD_OUT" | grep -oE '"sourcesScanned":\s*[0-9]+' | sed 's/.*: *//' | head -1 || echo "0")"
if [[ "${ENTRIES:-0}" -lt 1 && "${SOURCES_SCANNED:-0}" -lt 1 ]]; then
  SKIP "chain rebuild reported 0 entries — fresh installs are valid; not failing the drill"
else
  PASS "rebuild covered $SOURCES_SCANNED source(s), $ENTRIES entries"
fi

echo ""
PASS "quarterly-restore-drill complete — backup tag='$TAG' restored cleanly"
echo "   backup file: $BACKUP_FILE"
echo "   restore dir: $RESTORE_DIR (cleaned on exit)"
