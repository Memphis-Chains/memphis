#!/usr/bin/env bash
# schedule: 0 9 * * *
#
# Memphis daily 09:00 briefing entry point.
# The report implementation lives in morning-report.sh; this wrapper adds
# overlap protection and a bounded runtime for cron execution.

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SELF_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
readonly REPORT_SCRIPT="${MEMPHIS_DAILY_BRIEFING_TARGET:-$SCRIPT_DIR/morning-report.sh}"
readonly TIMEOUT_SECONDS="${MEMPHIS_DAILY_BRIEFING_TIMEOUT_SECONDS:-180}"
readonly LOCK_DIR="${MEMPHIS_HOME:-$HOME/.memphis}/locks"
readonly LOCK_FILE="$LOCK_DIR/daily-9am-briefing.lock"

if ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || [ "$TIMEOUT_SECONDS" -gt 3600 ]; then
  echo "daily briefing: timeout must be an integer between 1 and 3600 seconds" >&2
  exit 2
fi

if [ "$(realpath -m -- "$REPORT_SCRIPT")" = "$(realpath -m -- "$SELF_PATH")" ]; then
  echo "daily briefing: refusing recursive self-execution" >&2
  exit 2
fi

if [ ! -f "$REPORT_SCRIPT" ]; then
  echo "daily briefing: report script not found: $REPORT_SCRIPT" >&2
  exit 2
fi

mkdir -p "$LOCK_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "daily briefing: another run is already active; skipping" >&2
  exit 0
fi

exec timeout --signal=TERM --kill-after=10s "$TIMEOUT_SECONDS" bash "$REPORT_SCRIPT"
