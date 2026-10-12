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

# Find the partition by label rather than by device node. `lsblk -o LABEL` is
# used rather than parsing `udisksctl info`: the output field there is named
# `IdLabel`, and that spelling has changed between udisks2 versions, so the
# first version of this script found no partition on this host while the drive
# was plugged in and correctly labelled.
PART=""
while read -r dev _label; do
  [ "$_label" = "$LABEL" ] || continue
  PART="$dev"
  break
done < <(lsblk -lnpo NAME,TYPE,LABEL 2>/dev/null | awk '$2=="part" && $3!="" {print $1, $3}')

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