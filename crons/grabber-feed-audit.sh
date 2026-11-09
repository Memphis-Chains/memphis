#!/usr/bin/env bash
# schedule: 0 6 * * *
#
# WHY THIS WAS REWRITTEN
# -----------------------
# Measured 2026-11-06: this task had failed 11 out of 11 runs, every day
# since it was created, and the scheduler reported `success: false` with an
# EMPTY output every time. Three defects, all measured on this host:
#
#   1. The body called
#          bash /home/memphis/memphis/scripts/usb-grabber-test.py ...
#      but usb-grabber-test.py is a PYTHON file (shebang
#      `#!/usr/bin/env python3`). Running it under bash produced eleven
#      "import: command not found" lines and a syntax error on the
#      `DEVICE = sys.argv[1] ...` line — every single run. The daily log
#      held nothing but those bash errors.
#   2. `2>&1 | tail -20 >> log` under `set -euo pipefail` propagates the
#      probe's exit code, which made "the grabber is not answering" look
#      identical to "this script is broken" — two different things that
#      need two different responses.
#
# Measured 2026-11-09, after the first rewrite: the audit reported a
# verdict about hardware that was not involved. The probe was called with
# no device argument, so it fell back to its own default `/dev/video0` —
# and on this host `/dev/video0` is the v4l2loopback DUMMY device
# (ID_V4L_PRODUCT="Dummy video device (0x0000)", driver v4l2loopback).
# The audit read a virtual sink and wrote `video: OK` into the daily log
# every day, while the physical grabber was never opened. The audio side
# had the same shape: `hw:2,0` was hardcoded, and the card at that index
# is the NVIDIA HDMI device, which is playback-only.
#
# The device is now DISCOVERED, not assumed: scripts/grabber_devices.py
# reads sysfs and procfs and returns the real capture device, or nothing.
# Three states, because they need three different responses:
#
#   - no capture device present  -> the grabber is not plugged in.
#     The audit records that and stops. This is not a failure of the
#     probe, and it is not a failure of the script.
#   - capture device present, probe reports a bad verdict -> the grabber
#     is there and not working. Recorded, task still succeeds.
#   - the probe could not run at all -> the script is broken. Task fails.
#
# A verdict goes to the log; only a BROKEN script fails the task.
# usb-grabber-test.py exits 0 (ok), 1 (video failure), 2 (audio failure),
# 3 (device present but unusable) — those are findings to report, not
# scheduler errors. A non-zero exit above 3 means the probe itself could
# not run.
set -uo pipefail

LOG="${MEMPHIS_GRABBER_LOG:-/home/memphis/.memphis/logs/grabber-feed-daily.log}"

# The repo root is derived from this script's own location, not hardcoded.
# The script lives in <repo>/crons/, so the parent of its directory is the
# root — and the helper sits next to it in <repo>/scripts/.
#
# Measured 2026-11-09: the absolute path /home/memphis/memphis/scripts/...
# works on the operator's host and nowhere else. The contract suite runs
# the script from a checkout under /home/runner/work/..., where that path
# does not exist, so the discovery step failed with exit 2 and the audit
# reported BROKEN instead of a verdict. A hardcoded home directory is an
# assumption about where the machine lives, not about where the code is.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO_ROOT/scripts/usb-grabber-test.py"
DEVICES="$REPO_ROOT/scripts/grabber_devices.py"
mkdir -p "$(dirname "$LOG")"

# Which devices this host actually has. A missing key means the device is
# not present — that is a state, not a lookup error.
#
# stdout and stderr are kept apart: the JSON is read from stdout, and a
# diagnostic line on stderr would otherwise be parsed as part of it.
DEVICES_JSON="$(python3 "$DEVICES" 2>/tmp/grabber-devices-err.$$)"
DEVICES_RC=$?
if [ "$DEVICES_RC" -ne 0 ]; then
  echo "GRABBER_FEED_AUDIT_BROKEN rc=$DEVICES_RC (device discovery failed)"
  cat /tmp/grabber-devices-err.$$ 2>/dev/null
  rm -f "/tmp/grabber-devices-err.$$"
  exit 1
fi

read -r CAPTURE_DEVICE AUDIO_DEVICE <<EOF
$(printf '%s' "$DEVICES_JSON" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR PARSE_ERROR")
    raise SystemExit(0)
print((data.get("capture_device") or "NONE"), (data.get("usb_audio_device") or "NONE"))
')
EOF
rm -f "/tmp/grabber-devices-err.$$"

if [ "$CAPTURE_DEVICE" = "PARSE_ERROR" ]; then
  echo "GRABBER_FEED_AUDIT_BROKEN (device discovery returned unreadable output)"
  exit 1
fi
[ "$CAPTURE_DEVICE" = "NONE" ] && CAPTURE_DEVICE=""
[ "$AUDIO_DEVICE" = "NONE" ] && AUDIO_DEVICE=""

if [ -z "$CAPTURE_DEVICE" ]; then
  {
    echo "=== $(date -Iseconds) grabber feed audit ==="
    echo "capture_device: none (no real capture device on this host)"
    echo "usb_audio_device: ${AUDIO_DEVICE:-none}"
    echo "verdict: NOT_CONNECTED"
  } >> "$LOG"
  echo "GRABBER_FEED_AUDIT verdict=NOT_CONNECTED (no capture device present)"
  exit 0
fi

OUT="$(python3 "$PROBE" "$CAPTURE_DEVICE" 2>&1)"
RC=$?
{
  echo "=== $(date -Iseconds) grabber feed audit ==="
  echo "capture_device: $CAPTURE_DEVICE"
  echo "usb_audio_device: ${AUDIO_DEVICE:-none}"
  printf '%s\n' "$OUT"
} >> "$LOG"

if [ "$RC" -gt 3 ]; then
  echo "GRABBER_FEED_AUDIT_BROKEN rc=$RC (probe could not run)"
  printf '%s\n' "$OUT" | tail -20
  exit 1
fi

echo "GRABBER_FEED_AUDIT verdict_rc=$RC device=$CAPTURE_DEVICE (logged to $LOG)"
exit 0
