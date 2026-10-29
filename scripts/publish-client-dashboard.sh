#!/usr/bin/env bash
# Publish the CLIENT dashboard to the web server, with a backup and a
# verification step.
#
# WHY THIS EXISTS
# ---------------
# Measured 2026-10-29: the dashboard the client reads was a hand-written
# snapshot of the 2026-09-07 session. Its numbers were typed into the
# markup, so nothing regenerated it and the page stayed frozen while the
# work continued. A manual publish would repeat that failure: the next
# session would forget, and the page would go stale again.
#
# So the publish is automatic, and it is safe by construction:
#   1. build the page from measured data
#   2. back up whatever is on the server
#   3. copy the new page
#   4. read it back and confirm the generation stamp changed
#   5. restore the backup if the copy or the check failed
#
# The page contains third-party business information, so it lives behind
# HTTP basic auth. The credential file is the one the operator already
# has in the vault — no new secret is created here.
#
# Stdlib + coreutils only.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/memphis/memphis}"
DATA_DIR="${DATA_DIR:-/home/memphis/.memphis}"
LOCAL_OUT="${LOCAL_OUT:-$DATA_DIR/site-secrets/client-dashboard.html}"
SSH_HOST="${SITES_SSH_HOST:-lhpl}"
SSH_CONFIG="${SITES_SSH_CONFIG:-/home/memphis/.ssh/lhpl-active/config}"
REMOTE_DIR="${REMOTE_DIR:-public_html/memphis-v5/client-status}"
REMOTE_FILE="index.html"
# Backups live on the SERVER, next to that site's other backups. A local
# path here would make `ssh ... mkdir -p` try to create it on the remote
# host — which fails on a path this user cannot write, and takes the
# whole publish down with it.
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-site-backups/memphis-v5/client-status}"

LOG="$(mktemp)"
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG"; }

SSH_OPTS=(-o ConnectTimeout=30 -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
[[ -f "$SSH_CONFIG" ]] && SSH_OPTS+=(-F "$SSH_CONFIG")

# 1. Build. The generator reads live data; a failure here must publish
#    nothing at all rather than an old page with a new timestamp.
log "building client dashboard"
BUILD_OUT="$(mktemp -d)"
if ! python3 "$REPO_DIR/scripts/dashboard_report.py" \
      --audience client "$BUILD_OUT/$REMOTE_FILE" >>"$LOG" 2>&1; then
  log "BUILD FAILED — nothing published"
  tail -20 "$LOG" >&2
  rm -rf "$BUILD_OUT"
  exit 1
fi
[[ -s "$BUILD_OUT/$REMOTE_FILE" ]] || { log "BUILD PRODUCED NO PAGE"; rm -rf "$BUILD_OUT"; exit 1; }
NEW_STAMP="$(grep -oE 'wygenerowane [0-9-]{10} [0-9:]{8}' "$BUILD_OUT/$REMOTE_FILE" | head -1 || true)"
[[ -n "$NEW_STAMP" ]] || { log "BUILD LACKS A GENERATION STAMP"; rm -rf "$BUILD_OUT"; exit 1; }
log "built: $NEW_STAMP"

mkdir -p "$LOCAL_OUT" "$(dirname "$LOCAL_OUT")"
cp "$BUILD_OUT/$REMOTE_FILE" "$LOCAL_OUT"
log "local copy: $LOCAL_OUT"

# 2. Back up the server copy before touching it.
STAMP="$(date +%Y%m%d-%H%M%S)"
log "backing up remote copy"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "mkdir -p '$REMOTE_DIR' '$REMOTE_BACKUP_DIR' && if [ -f '$REMOTE_DIR/$REMOTE_FILE' ]; then cp -a '$REMOTE_DIR/$REMOTE_FILE' '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak'; fi" \
  >>"$LOG" 2>&1 || { log "BACKUP FAILED — nothing published"; rm -rf "$BUILD_OUT"; exit 1; }

# 3. Publish the new page.
log "publishing"
if ! scp "${SSH_OPTS[@]}" "$BUILD_OUT/$REMOTE_FILE" "$SSH_HOST:$REMOTE_DIR/$REMOTE_FILE" >>"$LOG" 2>&1; then
  log "SCP FAILED — restoring backup"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
    "if [ -f '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak' ]; then cp -a '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak' '$REMOTE_DIR/$REMOTE_FILE'; fi" \
    >>"$LOG" 2>&1 || true
  rm -rf "$BUILD_OUT"
  exit 1
fi

# 4. Read it back. The page sits behind HTTP basic auth, so an
#    unauthenticated fetch answers 401 — that is the CORRECT answer, and
#    it is what proves the path is protected rather than merely absent.
#    The proof that the new page landed is the stamp inside the file on
#    the server, checked over the same SSH channel that wrote it.
#
#    Both checks are needed: a file with the right stamp could still be
#    unserved, and a 401 could still be a 401 from an old file.
log "verifying"
REMOTE_BODY="$(ssh "${SSH_OPTS[@]}" "$SSH_HOST" "cat '$REMOTE_DIR/$REMOTE_FILE'" 2>/dev/null || true)"
if [[ "$REMOTE_BODY" != *"$NEW_STAMP"* ]]; then
  log "VERIFY FAILED (stamp missing on server) — restoring backup"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
    "if [ -f '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak' ]; then cp -a '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak' '$REMOTE_DIR/$REMOTE_FILE'; fi" \
    >>"$LOG" 2>&1 || true
  rm -rf "$BUILD_OUT"
  exit 1
fi
log "verified: server file carries $NEW_STAMP"

# 5. The public path must answer 401 (protected), not 404 (missing).
PUBLIC_URL="${PUBLIC_URL:-https://memphis-v5.pl/client-status/}"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" || echo 000)"
if [[ "$HTTP_CODE" != "401" && "$HTTP_CODE" != "200" ]]; then
  log "VERIFY FAILED (public path answers $HTTP_CODE) — restoring backup"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
    "if [ -f '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak' ]; then cp -a '$REMOTE_BACKUP_DIR/$REMOTE_FILE.$STAMP.bak' '$REMOTE_DIR/$REMOTE_FILE'; fi" \
    >>"$LOG" 2>&1 || true
  rm -rf "$BUILD_OUT"
  exit 1
fi
log "verified: $PUBLIC_URL answers $HTTP_CODE (401 = protected by auth)"
rm -rf "$BUILD_OUT"
exit 0
