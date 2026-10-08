#!/usr/bin/env bash
# install-managed-app-units.sh — install the optional managed-app units and
# create the state directories they log into.
#
# Why this exists (measured 2026-10-08): lr-dashboard.service uses
#   StandardOutput=append:~/.memphis/apps/lr-dashboard/state/lr-dashboard.systemd.log
# systemd does NOT create missing parent directories for `append:` — it fails
# the unit at step STDOUT with 209/STDOUT, before ExecStart runs. An
# ExecStartPre=/usr/bin/mkdir does not help either: stdout is opened before
# ExecStartPre executes, so the mkdir itself dies at STDOUT.
#
# The result on the operator's host was 325 restarts in 12 hours, each
# appending the same failure line every 5 s to the journal.
#
# Units here are NOT installed by default — see scripts/systemd/README.md.
# Run this explicitly on a host that wants them.

set -euo pipefail

MEMPHIS_ROOT="${MEMPHIS_ROOT:-$HOME/.memphis}"
UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

UNITS=(
    lr-dashboard.service
)

# Every managed app logs under apps/<name>/state. Create them up front so
# systemd never has to open a file inside a directory that does not exist.
APP_STATE_DIRS=(
    "$MEMPHIS_ROOT/apps/lr-dashboard/state"
)

for d in "${APP_STATE_DIRS[@]}"; do
    mkdir -p "$d"
    echo "[install-managed-app-units] state dir ready: $d"
done

installed=()
for unit in "${UNITS[@]}"; do
    src="$SCRIPT_DIR/$unit"
    if [ ! -f "$src" ]; then
        echo "[install-managed-app-units] SKIP (not in repo): $unit" >&2
        continue
    fi
    mkdir -p "$UNIT_DIR"
    # Install only when it actually differs, so daemon-reload does not
    # churn on every run.
    if [ -f "$UNIT_DIR/$unit" ] && cmp -s "$src" "$UNIT_DIR/$unit"; then
        echo "[install-managed-app-units] unchanged: $unit"
    else
        cp "$src" "$UNIT_DIR/$unit"
        installed+=("$unit")
        echo "[install-managed-app-units] installed: $unit"
    fi
done

systemctl --user daemon-reload
echo "[install-managed-app-units] daemon-reload done (${#installed[@]} changed)"

for unit in "${installed[@]:-}"; do
    [ -n "$unit" ] || continue
    systemctl --user enable --now "$unit" || {
        echo "[install-managed-app-units] ERROR: start failed for $unit" >&2
        systemctl --user --no-pager status "$unit" || true
        exit 1
    }
done
