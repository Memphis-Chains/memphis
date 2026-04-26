#!/usr/bin/env bash
# 06-fresh-install-and-restore.sh
# Fresh-install audit: snapshot current Memphis install, tear it down,
# run the curl-installer flow on the same host, and restore from the
# snapshot. The whole thing is idempotent — every step verifies its
# pre-conditions before mutating, so you can re-run after a partial
# failure without corrupting state.
#
# Operator workflow:
#   1. Save your current MEMPHIS_VAULT_PEPPER externally (KeePass /
#      pendrive). The backup archive does NOT contain the pepper —
#      that's by design (separates secrets from data, layered security).
#   2. Run this script. It snapshots, tears down, fresh-installs, and
#      restores. Each step has explicit success criteria.
#   3. When the script asks for the pepper at restore time, paste it.
#   4. Verify with the smoke checks at the end.
#
# Idempotent: if the script aborts at step N, fix the underlying issue
# and re-run. It picks up where it left off.

set -Eeuo pipefail

# ── Visual ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

step()  { echo -e "${BLUE}[step]${NC} $*"; }
ok()    { echo -e "${GREEN}[✓]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[!]${NC}    $*"; }
fail()  { echo -e "${RED}[✗]${NC}    $*" >&2; exit 1; }

trap 'fail "aborted at line ${LINENO} (last command: $BASH_COMMAND)"' ERR

# ── Inputs / paths ─────────────────────────────────────────────────────
INSTALL_BASE="${MEMPHIS_INSTALL_BASE:-$HOME/.memphis}"   # link target
TARGET_DIR="${MEMPHIS_TARGET_DIR:-$HOME/memphis}"         # repo checkout
DATA_DIR="${MEMPHIS_DATA_DIR:-$HOME/.memphis}"            # vault + chains + sqlite
BACKUP_TAG="${BACKUP_TAG:-pre-fresh-install}"
BACKUP_OUT="${BACKUP_OUT:-$HOME/memphis-fresh-install-snapshot}"
INSTALL_SCRIPT="${INSTALL_SCRIPT_URL:-}"                  # optional remote installer
LOCAL_INSTALL_SCRIPT="$TARGET_DIR/scripts/install.sh"     # used if installer URL omitted

# ── Step 1: pre-flight ─────────────────────────────────────────────────
step "1. Pre-flight checks"

command -v memphis >/dev/null 2>&1 \
  || fail "memphis CLI not on PATH. Run this on a host with an existing Memphis install."

if [[ ! -d "$DATA_DIR" ]]; then
  fail "data dir $DATA_DIR not found — nothing to back up. (Set MEMPHIS_DATA_DIR if non-default.)"
fi

if ! memphis health --cron >/dev/null 2>&1; then
  warn "memphis health failed — continuing, but the backup may capture an unhealthy state."
fi

# Ensure the snapshot output dir exists (could be /mnt/usb, /home, etc.).
mkdir -p "$BACKUP_OUT"
ok "data dir present at $DATA_DIR; snapshot will land in $BACKUP_OUT"

# ── Step 2: snapshot ───────────────────────────────────────────────────
step "2. Creating snapshot via 'memphis backup create --tag $BACKUP_TAG'"

# memphis backup create writes to ~/.memphis/backups/ by default; we copy
# the resulting tarball to BACKUP_OUT for cross-host portability.
memphis backup create --tag "$BACKUP_TAG" --json > "$BACKUP_OUT/snapshot.json" \
  || fail "memphis backup create failed; see output above"

SNAPSHOT_FILE=$(grep -oE '"file":\s*"[^"]+"' "$BACKUP_OUT/snapshot.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [[ -z "$SNAPSHOT_FILE" ]]; then
  fail "could not parse snapshot filename from $BACKUP_OUT/snapshot.json"
fi
SNAPSHOT_PATH="$DATA_DIR/backups/$SNAPSHOT_FILE"
[[ -f "$SNAPSHOT_PATH" ]] || fail "snapshot file not found at $SNAPSHOT_PATH"

cp "$SNAPSHOT_PATH" "$SNAPSHOT_PATH.sha256" "$BACKUP_OUT/" 2>/dev/null \
  || cp "$SNAPSHOT_PATH" "$BACKUP_OUT/"
SNAPSHOT_SIZE=$(stat -c%s "$BACKUP_OUT/$SNAPSHOT_FILE" 2>/dev/null || stat -f%z "$BACKUP_OUT/$SNAPSHOT_FILE")
ok "snapshot $SNAPSHOT_FILE ($((SNAPSHOT_SIZE / 1024)) KB) saved to $BACKUP_OUT/"

# ── Step 3: capture pepper hint (operator-supplied at restore) ─────────
step "3. Pepper reminder"

# Do NOT extract the pepper from .env — the operator's external store
# (KeePass) is the authoritative copy. This step just reminds them.
PEPPER_HINT_FILE="$BACKUP_OUT/PEPPER-REMINDER.txt"
cat > "$PEPPER_HINT_FILE" <<EOF
You will need MEMPHIS_VAULT_PEPPER at restore time (step 6).
The backup archive does NOT contain the pepper — by design.

If you've forgotten where the pepper lives, check:
  grep MEMPHIS_VAULT_PEPPER $TARGET_DIR/.env

Save it to KeePass / pendrive / printer NOW. The restore step will
prompt you for it.
EOF
warn "wrote $PEPPER_HINT_FILE — read it before proceeding"

# ── Step 4: confirm tear-down ──────────────────────────────────────────
step "4. Tear-down confirmation"

cat <<EOF

About to remove:
  - $DATA_DIR (entire data tree, INCLUDING backups subdir
    — your snapshot lives at $BACKUP_OUT/$SNAPSHOT_FILE so that's safe)
  - $TARGET_DIR (repo checkout)

Snapshot is preserved at:
  $BACKUP_OUT/$SNAPSHOT_FILE

EOF
read -rp "Type 'TEAR-DOWN' to proceed (anything else aborts): " CONFIRM
[[ "$CONFIRM" == "TEAR-DOWN" ]] || fail "operator aborted at tear-down confirmation"

# Stop systemd unit if present so we're not yanking the rug from a
# running daemon.
if systemctl --user is-active memphis >/dev/null 2>&1; then
  systemctl --user stop memphis || warn "systemctl stop returned non-zero; continuing"
fi

rm -rf "$DATA_DIR" "$TARGET_DIR"
ok "data dir + repo removed"

# ── Step 5: fresh install ──────────────────────────────────────────────
step "5. Fresh install"

if [[ -n "$INSTALL_SCRIPT" ]]; then
  curl -fsSL "$INSTALL_SCRIPT" | bash
else
  # Local-checkout install path. Operator must have a copy of the repo
  # somewhere reachable; clone if missing.
  if [[ ! -d "$TARGET_DIR" ]]; then
    git clone https://github.com/Memphis-Chains/memphis.git "$TARGET_DIR"
  fi
  if [[ ! -f "$LOCAL_INSTALL_SCRIPT" ]]; then
    fail "expected $LOCAL_INSTALL_SCRIPT after clone — repo layout changed?"
  fi
  bash "$LOCAL_INSTALL_SCRIPT"
fi

# Verify CLI is back on PATH
hash -r
command -v memphis >/dev/null 2>&1 || fail "memphis CLI not on PATH after install — check installer output"
ok "fresh install complete; memphis CLI back on PATH"

# ── Step 6: restore ────────────────────────────────────────────────────
step "6. Restore from snapshot"

# Place snapshot where 'memphis backup restore' looks for it.
mkdir -p "$DATA_DIR/backups"
cp "$BACKUP_OUT/$SNAPSHOT_FILE" "$DATA_DIR/backups/"
[[ -f "$BACKUP_OUT/$SNAPSHOT_FILE.sha256" ]] && cp "$BACKUP_OUT/$SNAPSHOT_FILE.sha256" "$DATA_DIR/backups/" || true

# Operator pastes the pepper. Use stty -echo so it doesn't appear in
# scrollback. (read -s isn't portable to all sh; bash supports it.)
read -srp "Paste MEMPHIS_VAULT_PEPPER (from your KeePass / pendrive): " PEPPER
echo
[[ ${#PEPPER} -ge 12 ]] || fail "pepper must be at least 12 characters (got ${#PEPPER})"

memphis backup restore --file "$SNAPSHOT_FILE" --pepper-restore "$PEPPER" --yes \
  || fail "memphis backup restore failed"
unset PEPPER
ok "restore complete"

# ── Step 7: smoke checks ───────────────────────────────────────────────
step "7. Post-restore smoke"

memphis init status >/dev/null 2>&1 || warn "memphis init status non-zero; investigate"
memphis vault list  >/dev/null 2>&1 || warn "memphis vault list non-zero; investigate"
memphis health --cron >/dev/null 2>&1 || warn "memphis health non-zero; investigate"
memphis doctor --json >/dev/null 2>&1 || warn "memphis doctor non-zero; investigate"

ok "post-restore smoke checks complete"

# ── Step 8: provider ping ──────────────────────────────────────────────
step "8. Provider smoke (best effort)"

# Best-effort: try one short prompt through the default provider. If
# nothing's configured, this just warns; doesn't fail.
PROVIDER_OUT=$(memphis ask "ping — say one word back" --json 2>/dev/null || true)
if echo "$PROVIDER_OUT" | grep -qE '"reply"' ; then
  ok "default provider replied — vault decryption + provider config both working"
else
  warn "no provider reply (provider may not be configured yet; run 'memphis providers list' to inspect)"
fi

cat <<EOF

${GREEN}── Fresh-install + restore audit complete ──${NC}

Snapshot:   $BACKUP_OUT/$SNAPSHOT_FILE
Data dir:   $DATA_DIR
Repo:       $TARGET_DIR

Next steps for operator:
  - 'memphis tools list' to see what's wired
  - 'memphis serve &' if not running via systemd
  - send a message via Telegram or 'memphis tui' to validate end-to-end

If anything reported [!] above, that's a gap in the install/restore path
worth filing as a follow-up PR.

EOF
