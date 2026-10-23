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
USB_KEEP=3
MIN_FREE_MB=200  # refuse copy if less than 200 MB free on USB

# 1. Locate USB mount.
#
#    Was hardcoded to /media/memphis/usb-backup, but that is the
#    pre-XDG automount location. This host mounts the drive through
#    systemd automount under /run/media/$USER/<label>, so the
#    hardcoded path pointed at an empty leftover directory and every
#    4h run logged "ERROR: ... is not a mountpoint" and exited 2 —
#    silently leaving the drive 2+ days behind (observed 2026-09-29;
#    newest archive on USB was from 2026-09-27).
#
#    Probe candidates in order, use the first real mountpoint.
#    MEMPHIS_USB_DIR override wins, so a re-labelled drive or a
#    different mount layout is handled without a code change.
# 0. Offsite state, so a missing copy is visible instead of silent.
#
#    The unit ran 58 times refusing to copy and 25 times reporting no mount,
#    and every one of those was invisible in `memphis health`: the health
#    payload described the LOCAL backup only. An offsite copy that silently
#    stops is the failure this state file exists to make loud.
#
#    Written atomically (temp file + rename) so a reader never sees a
#    half-written JSON, and with 0600 because it names a path on the drive.
STATE_FILE="${MEMPHIS_OFFSITE_STATE:-$HOME/.memphis/offsite-backup-state.json}"

write_state() {
    # $1 status: ok | up-to-date | no-usb | no-archive | copy-failed
    # $2 detail: free text, may be empty
    local status="$1" detail="${2:-}" tmp
    tmp="$(mktemp "${STATE_FILE}.XXXXXX" 2>/dev/null || echo "")"
    [ -n "$tmp" ] || return 0
    {
        printf '{\n'
        printf '  "status": "%s",\n' "$status"
        printf '  "detail": "%s",\n' "$(printf '%s' "$detail" | sed 's/\\/\\\\/g; s/"/\\"/g')"
        printf '  "updatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf '  "mount": "%s",\n' "${USB_DIR:-}"
        printf '  "archive": "%s"\n' "$(basename "${latest:-}" 2>/dev/null || echo "")"
        printf '}\n'
    } > "$tmp"
    chmod 600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$STATE_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

resolve_usb_dir() {
    local candidates=()
    # `set -u` is active and systemd does export USER on this host, but any
    # context that does not (cron, a bare `env -i`, some containers) aborted
    # the whole script with "USER: unbound variable" before the probe ran —
    # a crash masquerading as "no mountpoint" (measured rc=1, not 2).
    local user="${USER:-$(id -un)}"
    [ -n "${MEMPHIS_USB_DIR:-}" ] && candidates+=("$MEMPHIS_USB_DIR")
    candidates+=(
        "/run/media/$user/memphis-usb-back"
        "/media/$user/usb-backup"
        "/media/memphis/usb-backup"
    )
    local d
    for d in "${candidates[@]}"; do
        if [ -d "$d" ] && mountpoint -q "$d" 2>/dev/null; then
            printf '%s\n' "$d"
            return 0
        fi
    done
    return 1
}

if ! USB_DIR=$(resolve_usb_dir); then
    echo "[backup-to-usb] ERROR: no USB mount found (tried MEMPHIS_USB_DIR, /run/media/$(id -un)/memphis-usb-back, /media/$(id -un)/usb-backup, /media/memphis/usb-backup)" >&2
    write_state "no-usb" "no mountpoint found"
    exit 2
fi

echo "[backup-to-usb] using USB mount: $USB_DIR"

# 2. Verify write access
if ! touch "$USB_DIR/.write-test" 2>/dev/null; then
    echo "[backup-to-usb] ERROR: no write access to $USB_DIR (chown needed?)" >&2
    write_state "no-usb" "no write access to $USB_DIR"
    exit 2
fi
rm -f "$USB_DIR/.write-test" 2>/dev/null || true

# 3. Free space check
free_kb=$(df --output=avail "$USB_DIR" | tail -1 | tr -d ' ')
free_mb=$((free_kb / 1024))
if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
    echo "[backup-to-usb] ERROR: only ${free_mb} MB free on USB (need ${MIN_FREE_MB})" >&2
    write_state "no-usb" "only ${free_mb} MB free"
    exit 2
fi

# 4. Find latest valid backup (verify must pass)
# Select by newest PUBLISHED archive. A crash mid-archive leaves a
# `*.tar.gz.partial` behind, and plain `ls -t *.tar.gz | head -1` would pick
# the truncated file, refuse to copy it, and keep refusing on every run until
# an operator deleted it by hand. `-prune` removes those from consideration
# before sorting.
PARTIAL_SUFFIX='.partial'
latest=$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -type f -name "*.tar.gz" ! -name "*${PARTIAL_SUFFIX}" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2- || true)
if [ -z "$latest" ]; then
    echo "[backup-to-usb] ERROR: no published archives in $LOCAL_BACKUP_DIR" >&2
    write_state "no-archive" "no published archives"
    exit 1
fi

# Resolve the CLI to an absolute path before calling it. This script runs from
# a systemd timer, whose PATH is
#   /home/memphis/.cargo/bin:/home/memphis/.local/bin:/home/memphis/bin:/usr/...:/bin
# and does NOT contain ~/.local/share/npm-global/bin, where the `memphis`
# symlink lives. `memphis backup verify` therefore exited 127 (command not
# found), `if ! memphis ...` treated that as "verification failed", and the
# script reported every archive as corrupt. Same false-green as a real
# corruption, opposite direction: measured 58 refusals / 0 copies in 14 days
# against archives that `tar tzf` read fine.
MEMPHIS_BIN="${MEMPHIS_BIN:-$HOME/memphis/bin/memphis.js}"
if [ ! -f "$MEMPHIS_BIN" ]; then
    MEMPHIS_BIN="$(command -v memphis 2>/dev/null || true)"
fi
if [ -z "$MEMPHIS_BIN" ] || [ ! -f "$MEMPHIS_BIN" ]; then
    echo "[backup-to-usb] ERROR: memphis CLI not found (set MEMPHIS_BIN)" >&2
    write_state "no-archive" "memphis CLI not found"
    exit 1
fi

# `set -e` is active: a bare `out=$(cmd)` on the next line aborts the script
# before the status is ever read, so the diagnostic never printed (measured:
# rc=1 with empty stderr). Appending `|| true` is NOT the fix — it replaces
# `$?` with true's own 0. The status has to be captured inside the same
# `&&`/`||` list, where `set -e` does not trigger.
verify_out=$("${MEMPHIS_BIN}" backup verify "$latest" 2>&1) && verify_rc=0 || verify_rc=$?
if [ "$verify_rc" -ne 0 ]; then
    echo "[backup-to-usb] ERROR: latest archive $latest failed verify (rc=$verify_rc): $verify_out" >&2
    write_state "verify-failed" "latest archive failed verify"
    exit 1
fi

# 5. Copy (skip if already present with same sha256)
src_sha=$(sha256sum "$latest" | cut -d' ' -f1)
dest="$USB_DIR/$(basename "$latest")"
if [ -f "$dest" ]; then
    dest_sha=$(sha256sum "$dest" | cut -d' ' -f1)
    if [ "$src_sha" = "$dest_sha" ]; then
        chmod 600 "$dest" 2>/dev/null || true
        echo "[backup-to-usb] already up to date: $dest"
        write_state "up-to-date" "$(basename "$dest")"
        exit 0
    fi
fi

if ! cp "$latest" "$dest"; then
    echo "[backup-to-usb] ERROR: copy $latest -> $dest failed" >&2
    write_state "copy-failed" "copy of $(basename "$latest") failed"
    exit 3
fi

# Copy the digest sidecar too. Without it the offsite archive has no expected
# checksum, so `memphis backup verify` on the USB copy cannot tell a good copy
# from a corrupted one — the offsite copy exists precisely for the case where
# the local machine is gone.
sidecar="$latest.sha256"
if [ -f "$sidecar" ]; then
    if ! cp "$sidecar" "$dest.sha256"; then
        echo "[backup-to-usb] ERROR: copy $sidecar -> $dest.sha256 failed" >&2
        write_state "copy-failed" "copy of the digest sidecar failed"
        exit 3
    fi
    chmod 600 "$dest" "$dest.sha256" 2>/dev/null || true
else
    echo "[backup-to-usb] WARNING: no sidecar for $(basename "$latest"); offsite copy is unverifiable" >&2
fi

# 6. Rotate: keep last $USB_KEEP valid archives on USB
cd "$USB_DIR"
ls -t *.tar.gz 2>/dev/null | tail -n +$((USB_KEEP + 1)) | while read -r old; do
    echo "[backup-to-usb] rotating out: $old"
    rm -f "$old" 2>/dev/null || true
done

write_state "ok" "$(basename "$latest")"
echo "[backup-to-usb] OK: copied $(basename "$latest") to USB"
ls -la "$USB_DIR" 2>/dev/null | tail -n $((USB_KEEP + 2))