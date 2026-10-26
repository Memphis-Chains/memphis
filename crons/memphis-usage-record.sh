#!/usr/bin/env bash
# schedule: */10 * * * *
set -euo pipefail

#!/bin/bash
# Odśwież rekord usage Memphis dla panelu agentów Omarchy.
# Panel czyta katalog przy starcie i po refreshAll; ten cron utrzymuje liczby
# aktualnym, bo usage-update skanuje tylko $OMARCHY_PATH/bin (root-owned) i
# collectora Memphis tam nie włoży.
set -u
ud="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agents/usage"
collector="$HOME/.local/share/omarchy-agent-shim/omarchy-agent-usage-memphis"
[[ -x $collector ]] || exit 0
mkdir -p "$ud"
"$collector" >"$ud/.memphis.json.tmp" 2>/dev/null && chmod 0600 "$ud/.memphis.json.tmp" && mv "$ud/.memphis.json.tmp" "$ud/memphis.json"
