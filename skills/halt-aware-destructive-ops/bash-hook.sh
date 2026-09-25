# halt-aware-destructive-ops/bash-hook.sh
# Snippet to add to ~/.bashrc (or agent-specific rc) for automatic halt guarding.
#
# Install:
#   echo 'source ~/memphis/skills/halt-aware-destructive-ops/bash-hook.sh' >> ~/.bashrc
#
# Uninstall:
#   Remove the source line from ~/.bashrc.
#
# Behavior:
#   - Runs check.sh BEFORE every command matching destructive verbs (rm, mv, etc.)
#   - If check exits non-zero, ABORTS the command via `return 1` (DEBUG trap return
#     code propagates as command exit code; with errexit shell option, command is
#     aborted)
#   - To make the abort reliable, also enable `set -o errexit` (set -e) — but
#     that has wider effects. Better: use a wrapper function below that we
#     explicitly invoke from user prompts.
#
# Implementation note:
#   - DEBUG trap in bash cannot reliably abort a command. We provide TWO modes:
#     (1) Trap mode (informational, exit 1 printed, command still runs — useful for
#         audit trail even if command succeeded)
#     (2) Wrapper function mode (requires explicit invocation, e.g. user types
#         `halt_rm FILE` instead of `rm FILE`) — RELIABLE block
#   - For most cases, mode (1) is sufficient because the user sees the BLOCK
#     message and is expected to abort manually (Ctrl-C or `false`).
#   - For automated agents (memphis-tui, mcode), they should check exit code of
#     `halt_rm` and abort on failure.

_halt_guard() {
    local cmd_line="$1"
    local stripped="$cmd_line"
    while [[ "$stripped" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]* ]]; do
        stripped="${stripped#* }"
    done
    local first_word="${stripped%% *}"
    case "$first_word" in
        rm|mv|unlink|gio|cp)
            local rest="${stripped#* }"
            local -a check_args
            # shellcheck disable=SC2206
            check_args=($rest)
            if [ -x "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" ]; then
                if ! "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" "${check_args[@]}"; then
                    echo "halt-aware-destructive-ops: command BLOCKED — use HALT_BYPASS=1 to proceed consciously" >&2
                    # Return non-zero. With DEBUG trap, return code becomes the
                    # next command's exit code, but only if errexit is enabled.
                    # Without errexit, command still runs — that's why we echo a
                    # loud warning AND require the wrapper functions below.
                    return 1
                fi
            fi
            ;;
    esac
    return 0
}

# Wrapper functions (RELIABLE block — recommended for agents)
halt_rm() {
    if [ -x "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" ]; then
        "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" "$@"
        local rc=$?
        if [ $rc -ne 0 ] && [ "${HALT_BYPASS:-0}" != "1" ]; then
            return $rc
        fi
    fi
    command rm "$@"
}

halt_mv() {
    if [ -x "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" ]; then
        "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" "$@"
        local rc=$?
        if [ $rc -ne 0 ] && [ "${HALT_BYPASS:-0}" != "1" ]; then
            return $rc
        fi
    fi
    command mv "$@"
}

halt_gio_trash() {
    if [ -x "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" ]; then
        "$HOME/memphis/skills/halt-aware-destructive-ops/check.sh" "$@"
        local rc=$?
        if [ $rc -ne 0 ] && [ "${HALT_BYPASS:-0}" != "1" ]; then
            return $rc
        fi
    fi
    command gio trash "$@"
}

# Install as DEBUG trap (informational only). Disable with HALT_HOOK_DISABLED=1.
# For reliable block, agents should use halt_rm / halt_mv / halt_gio_trash instead.
if [ "${HALT_HOOK_DISABLED:-0}" != "1" ]; then
    trap '_halt_guard "$BASH_COMMAND"' DEBUG
fi
