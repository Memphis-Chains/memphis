#!/usr/bin/env bash
# Watchdog: checks the Memphis runtime on a timer and notifies only on a
# transition. Silent while healthy, so it never becomes wallpaper noise.
#
# State is the previous state. A notification fires when the state changes,
# not on every check — otherwise a machine that is down for an hour produces
# an hour of identical popups.
set -uo pipefail

STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/memphis-notify/watchdog.state"
NOTIFY="$HOME/memphis/bin/omarchy-notify.sh"
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null

[[ -x "$NOTIFY" ]] || exit 0

report="$(cd "$HOME/memphis" && timeout 45 node bin/memphis.js health --json 2>/dev/null)"

if [[ -z "$report" ]]; then
  current="unreachable"
else
  current="$(printf '%s' "$report" | jq -r '.runtimeStatus // "unknown"' 2>/dev/null)"
  # A runtime that answers "healthy" while recommending an action is not
  # actually healthy — surface it as degraded rather than passing it through.
  if [[ "$current" == "healthy" ]]; then
    rec="$(printf '%s' "$report" | jq -r '.recommendedAction // "none"' 2>/dev/null)"
    [[ "$rec" != "none" && "$rec" != "null" && -n "$rec" ]] && current="needs-attention"
  fi
fi

previous="$(cat "$STATE_FILE" 2>/dev/null || echo 'init')"
echo "$current" > "$STATE_FILE" 2>/dev/null

# First run: record the baseline silently, so installing the watchdog on a
# healthy machine does not announce that everything is fine.
[[ "$previous" == "init" ]] && exit 0
[[ "$current" == "$previous" ]] && exit 0

case "$current" in
  healthy)
    "$NOTIFY" "Memphis wrócił do normy" "Runtime znów raportuje healthy." --urgency low ;;
  unreachable)
    "$NOTIFY" "Memphis nie odpowiada" \
      "Serwer nie zwrócił statusu — sprawdź: systemctl --user status memphis" --urgency critical ;;
  needs-attention)
    action="$(printf '%s' "$report" | jq -r '.recommendedAction // "sprawdź status"' 2>/dev/null)"
    "$NOTIFY" "Memphis wymaga uwagi" "Zalecenie runtime: ${action}" --urgency normal ;;
  *)
    "$NOTIFY" "Memphis: ${current}" "Status runtime zmienił się." --urgency normal ;;
esac

exit 0
