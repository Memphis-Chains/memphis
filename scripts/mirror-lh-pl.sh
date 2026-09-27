#!/usr/bin/env bash
#
# mirror-lh-pl.sh — tier-0 local mirror of lh.pl public_html
#
# Co robi:
#   rsync lh.pl:public_html/ → ~/memphis-mirror/lh.pl/current/
#   retention: keeps N newest full snapshots, deletes older
#
# Dlaczego:
#   Zero off-host backup lh.pl = disaster recovery gap.
#   Panel-app critical (Klientów dane, Filament admin).
#   Mirror to local RPi zero-tier.
#
# Usage:
#   scripts/mirror-lh-pl.sh                # full mirror (default keep=7)
#   scripts/mirror-lh-pl.sh --keep 14     # keep 14 snapshots
#   scripts/mirror-lh-pl.sh --dry-run     # show what would happen
#
# Cron (systemd --user):
#   ~/.config/systemd/user/memphis-mirror-lh-pl.{timer,service}

set -euo pipefail

# --- Config ---
MIRROR_ROOT="${HOME}/memphis-mirror/lh.pl"
SSH_CONFIG="${HOME}/.ssh/lhpl-active/config"
SSH_HOST="lhpl"
REMOTE_PATH="/home/platne/serwer437043/public_html"
SNAPSHOT_DIR="${MIRROR_ROOT}/snapshots"
CURRENT_LINK="${MIRROR_ROOT}/current"
LOG_DIR="${HOME}/.memphis/logs"
LOG_FILE="${LOG_DIR}/mirror-lh-pl.log"

# --- Args ---
KEEP=7
DRY_RUN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)   KEEP="$2"; shift 2 ;;
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- Preflight ---
mkdir -p "$SNAPSHOT_DIR" "$LOG_DIR"
ts="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
target="${SNAPSHOT_DIR}/${ts}"

if [[ -n "$DRY_RUN" ]]; then
  echo "[dry-run] rsync would mirror ${SSH_HOST}:${REMOTE_PATH}/ → ${target}/"
  echo "[dry-run] rsync would prune $(ls -1 "$SNAPSHOT_DIR" 2>/dev/null | wc -l) → ${KEEP} newest"
  exit 0
fi

# --- Mirror ---
echo "[${ts}] start mirror → ${target}" >> "$LOG_FILE"
START_TIME=$(date +%s)

if ! rsync -a --delete \
      --exclude='.git/' \
      --exclude='node_modules/' \
      --exclude='vendor/' \
      --exclude='storage/logs/*.log' \
      --exclude='storage/framework/cache/data/*' \
      --exclude='.env' \
      -e "ssh -F ${SSH_CONFIG}" \
      "${SSH_HOST}:${REMOTE_PATH}/" \
      "${target}/" >> "$LOG_FILE" 2>&1; then
  echo "[${ts}] ERROR: rsync failed" >> "$LOG_FILE"
  exit 1
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
SIZE=$(du -sh "$target" 2>/dev/null | awk '{print $1}')
FILES=$(find "$target" -type f 2>/dev/null | wc -l)

# sha256 of whole snapshot (manifest, not content — content already at lh.pl)
CHECKSUM=$(find "$target" -type f -exec sha256sum {} \; 2>/dev/null | sha256sum | awk '{print $1}')

# Update 'current' symlink atomically
ln -sfn "$target" "${CURRENT_LINK}.new"
mv -T "${CURRENT_LINK}.new" "$CURRENT_LINK"

# --- Retention ---
total=$(ls -1 "$SNAPSHOT_DIR" 2>/dev/null | wc -l)
if (( total > KEEP )); then
  cd "$SNAPSHOT_DIR"
  ls -1t | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf "$old"
    echo "[${ts}] pruned old snapshot: ${old}" >> "$LOG_FILE"
  done
fi

# --- Log success ---
echo "[${ts}] ok duration=${DURATION}s size=${SIZE} files=${FILES} sha256=${CHECKSUM:0:16}.. kept=${KEEP}" >> "$LOG_FILE"
echo "duration=${DURATION}s size=${SIZE} files=${FILES} sha256=${CHECKSUM:0:16}..."
