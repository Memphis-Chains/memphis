#!/usr/bin/env bash
# Mount the backup USB if it is present, as the operator user.
#
# Why this exists: /run is tmpfs, so a mount made in one boot is gone in the
# next, and `backup-to-usb.sh` deliberately never mounts anything itself — it
# only accepts a directory that is already a mountpoint. The result measured on
# this host: 25 consecutive "no USB mount found" every 4h, while the drive was
# plugged in the whole time. The drive is formatted with this script's label,
# so the script mounts the label rather than a device path that can change when
# another USB stick is inserted first.
#
# `udisksctl` is used instead of `mount` because it does not need root, and
# because it is the same path the desktop automounter uses. Exit 0 when the
# drive is present and mounted, 2 when it is absent — so callers can treat
# "no drive plugged in" as normal rather than as a failure.
set -uo pipefail

LABEL="${MEMPHIS_USB_LABEL:-memphis-usb-back}"
USER_NAME="${USER:-$(id -un)}"
MNT="/run/media/$USER_NAME/$LABEL"

# Already mounted by the desktop automounter, or by a previous run.
if mountpoint -q "$MNT" 2>/dev/null; then
  exit 0
fi

if ! command -v udisksctl >/dev/null 2>&1; then
  echo "usb-backup-mount: udisksctl unavailable, cannot mount" >&2
  exit 2
fi

# Find the partition by label rather than by device node, so plugging in a
# different USB stick first cannot redirect the copy.
#
# Two lookup paths, because each one alone fails somewhere this project runs.
# `lsblk -o LABEL` does not exist on macOS — the first version of this script
# used it alone and the contract test failed there, not on the drive. `blkid`
# prints LABEL= on both, so it leads; `lsblk` stays as a fallback for hosts
# where blkid needs privileges this script does not have. Parsing
# `udisksctl info` is deliberately not used: that field is named `IdLabel`,
# and the spelling has moved between udisks2 versions.
PART=""
if command -v blkid >/dev/null 2>&1; then
  while IFS= read -r dev; do
    [ -n "$dev" ] || continue
    if blkid "$dev" 2>/dev/null | grep -q "^LABEL=\"$LABEL\"$"; then
      PART="$dev"
      break
    fi
  done < <(blkid -o device 2>/dev/null)
fi
if [ -z "$PART" ] && command -v lsblk >/dev/null 2>&1; then
  while read -r dev _label; do
    [ "$_label" = "$LABEL" ] || continue
    PART="$dev"
    break
  done < <(lsblk -lnpo NAME,TYPE,LABEL 2>/dev/null | awk '$2=="part" && $3!="" {print $1, $3}')
fi

if [ -z "$PART" ]; then
  echo "usb-backup-mount: no partition labelled $LABEL found (drive absent?)"
  exit 2
fi

OUT="$(udisksctl mount -b "$PART" 2>&1)"
if ! mountpoint -q "$MNT" 2>/dev/null; then
  echo "usb-backup-mount: mount did not produce $MNT — $OUT" >&2
  exit 2
fi

echo "usb-backup-mount: $PART mounted at $MNT"
exit 0