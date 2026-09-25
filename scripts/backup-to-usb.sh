#!/usr/bin/env bash
# backup-to-usb.sh — copy the latest valid memphis backup to USB.
#
# Triggered by cron task `backup-to-usb` (idempotent).
# Keep last 3 valid archives on USB; rotate older ones.
#
# Exit codes:
#   0 — success (copy + rotate OK)
#   1 — no valid archive to copy
#   2 — USB not mounted
#   3 — copy failed

set -euo pipefail

LOCAL_BACKUP_DIR="$HOME/.memphis/backups"
USB_DIR="/media/memphis/usb-backup"
USB_KEEP=3
MIN_FREE_MB=200  # refuse copy if less than 200 MB free on USB

# 1. Verify USB mounted
if ! mountpoint -q "$USB_DIR" 2>/dev/null; then
    echo "[backup-to-usb] ERROR: $USB_DIR is not a mountpoint" >&2
    exit 2
fi

# 2. Verify write access
if ! touch "$USB_DIR/.write-test" 2>/dev/null; then
    echo "[backup-to-usb] ERROR: no write access to $USB_DIR (chown needed?)" >&2
    exit 2
fi
rm -f "$USB_DIR/.write-test" 2>/dev/null || true

# 3. Free space check
free_kb=$(df --output=avail "$USB_DIR" | tail -1 | tr -d ' ')
free_mb=$((free_kb / 1024))
if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
    echo "[backup-to-usb] ERROR: only ${free_mb} MB free on USB (need ${MIN_FREE_MB})" >&2
    exit 2
fi

# 4. Find latest valid backup (verify must pass)
latest=$(ls -t "$LOCAL_BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1 || true)
if [ -z "$latest" ]; then
    echo "[backup-to-usb] ERROR: no archives in $LOCAL_BACKUP_DIR" >&2
    exit 1
fi

if ! memphis backup verify "$latest" >/dev/null 2>&1; then
    echo "[backup-to-usb] ERROR: latest archive $latest failed verify, refusing to copy" >&2
    exit 1
fi

# 5. Copy (skip if already present with same sha256)
src_sha=$(sha256sum "$latest" | cut -d' ' -f1)
dest="$USB_DIR/$(basename "$latest")"
if [ -f "$dest" ]; then
    dest_sha=$(sha256sum "$dest" | cut -d' ' -f1)
    if [ "$src_sha" = "$dest_sha" ]; then
        echo "[backup-to-usb] already up to date: $dest"
        exit 0
    fi
fi

if ! cp "$latest" "$dest"; then
    echo "[backup-to-usb] ERROR: copy $latest -> $dest failed" >&2
    exit 3
fi

# 6. Rotate: keep last $USB_KEEP valid archives on USB
cd "$USB_DIR"
ls -t *.tar.gz 2>/dev/null | tail -n +$((USB_KEEP + 1)) | while read -r old; do
    echo "[backup-to-usb] rotating out: $old"
    rm -f "$old" 2>/dev/null || true
done

echo "[backup-to-usb] OK: copied $(basename "$latest") to USB"
ls -la "$USB_DIR" 2>/dev/null | tail -n $((USB_KEEP + 2))