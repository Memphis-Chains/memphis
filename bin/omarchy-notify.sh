#!/usr/bin/env bash
# Memphis → Omarchy notifications.
#
# Bridges Memphis runtime events to desktop notifications through
# `omarchy-notification-send`, which routes into the quickshell notification
# service — the same one a browser or terminal app would use. Memphis stops
# being a thing you open and becomes a thing that speaks up on its own.
#
# Usage:
#   omarchy-notify.sh "<headline>" ["<description>"] [--urgency low|normal|critical]
#   omarchy-notify.sh --quiet          # suppress the next notification
#
# Never fails the caller: notification delivery is best-effort and must
# never break whatever was trying to notify.
set -uo pipefail

MEMPHIS_HOME="${MEMPHIS_HOME:-$HOME/memphis}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/memphis-notify"
LOG="$STATE_DIR/notify.log"
MUTE_FILE="$STATE_DIR/quiet"

mkdir -p "$STATE_DIR" 2>/dev/null

quiet=0
urgency="normal"
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) quiet=1; shift ;;
    --urgency) urgency="${2:-normal}"; shift 2 ;;
    --) shift; args+=("$@"); break ;;
    *) args+=("$1"); shift ;;
  esac
done

# A mute marker younger than its window silences this event. The window stops
# a --quiet from disabling the channel permanently after one noisy moment.
if [[ -f "$MUTE_FILE" ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$MUTE_FILE" 2>/dev/null || echo 0) ))
  if (( age < 1800 )); then
    rm -f "$MUTE_FILE"
    exit 0
  fi
  rm -f "$MUTE_FILE"
fi

if [[ "$quiet" == "1" ]]; then
  exit 0
fi

headline="${args[0]:-}"
description="${args[1]:-}"
[[ -z "$headline" ]] && exit 0

printf '%s\t%s\t%s\n' "$(date -Is)" "$urgency" "$headline" >> "$LOG" 2>/dev/null

# Keep the log from growing without bound in a long-lived session.
if [[ -f "$LOG" ]]; then
  lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if (( lines > 200 )); then
    tail -100 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
fi

command -v omarchy-notification-send >/dev/null 2>&1 || exit 0

timeout 10 omarchy-notification-send \
  --app-name "memphis" \
  --urgency "$urgency" \
  "$headline" "$description" >/dev/null 2>&1 || true

exit 0
