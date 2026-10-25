#!/usr/bin/env bash
# failure-alert.sh — deliver a systemd OnFailure alert to the operator.
#
# WHY THIS EXISTS
# ---------------
# memphis-monday-admin-failure-alert.service and
# memphis-tuesday-code-failure-alert.service were shipped as a 71-byte stub:
#
#     [Unit]
#     Description=Alert operator: memphis-monday-admin.service failed
#
# No [Service] section, therefore no ExecStart, therefore systemd refuses to
# run them:
#
#     Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.
#
# The refusal was logged on every boot and in bursts of five on 2026-10-23,
# and the operator was never told that either digest failed. The OnFailure=
# wiring in the two parent units was correct all along; only the alert side
# was missing.
#
# WHY THIS IS A SCRIPT AND NOT `ExecStart=/bin/bash -c 'curl ...'`
# ---------------------------------------------------------------------
# Two reasons, both measured:
#
#   1. The bot token lives in the vault. MEMPHIS_TELEGRAM_BOT_TOKEN in .env
#      is the literal `VAULT:telegram_bot_token`, and the runtime refuses to
#      send that string to Telegram (the 2026-04-20 crash loop: the literal
#      "VAULT:telegram_bot_token" shipped to getMe and returned 404). Only
#      the memphis CLI resolves the vault reference, so the alert must go
#      through `memphis telegram send`, not through raw curl.
#
#   2. The alert must not spam. The stub was started in bursts — five
#      attempts within three seconds on 2026-10-23, and once per boot
#      (2026-10-24 08:45, 08:57, 08:59, 17:04). A Telegram message per
#      attempt would bury the operator. The throttle below keeps one
#      message per failure per window, and always writes the full detail to
#      the journal regardless.
#
# EXIT CODES
# ----------
#   0 — alert delivered, or throttled (both are "handled")
#   1 — alert could not be delivered (message is in the journal)
#
# The parent unit's own exit status is what matters for OnFailure chains;
# this script never masks the original failure.

set -uo pipefail

UNIT_NAME="${1:-unknown-unit}"
REPO="${MEMPHIS_REPO:-$HOME/memphis}"
LOG_DIR="${MEMPHIS_LOG_DIR:-$HOME/.memphis/logs}"
STATE_DIR="${MEMPHIS_STATE_DIR:-$HOME/.memphis/state}"
THROTTLE_SECONDS="${MEMPHIS_ALERT_THROTTLE_SECONDS:-3600}"

# systemd user units do not inherit the shell PATH (see crons/monday-admin.sh).
export PATH="/home/memphis/.local/share/npm-global/bin:/home/memphis/.cargo/bin:/home/memphis/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$LOG_DIR" "$STATE_DIR"

STAMP="$(date -Is)"
THROTTLE_FILE="$STATE_DIR/failure-alert-${UNIT_NAME}.epoch"

# --- gather the failure detail ------------------------------------------------
# %N is the specifier that carries the failure reason; %E carries the
# directory systemd dropped the unit's logs into.
FAILED_LINE="$(systemctl --user status "$UNIT_NAME" --no-pager --full 2>&1 | head -20)"
STATUS_LINE="$(systemctl --user show "$UNIT_NAME" -p Result -p ExecMainStatus -p ExecMainCode -p InactiveEnterTimestamp --value 2>&1 | tr '\n' ' ')"

MESSAGE="🚨 Memphis unit failed: ${UNIT_NAME}
${STAMP}
${STATUS_LINE}

$(printf '%s' "$FAILED_LINE" | head -12)"

echo "=== ${STAMP} ALERT unit=${UNIT_NAME} ==="
echo "$MESSAGE"
echo

# --- throttle ------------------------------------------------------------------
NOW_EPOCH="$(date +%s)"
LAST_EPOCH=0
if [ -f "$THROTTLE_FILE" ]; then
  LAST_EPOCH="$(cat "$THROTTLE_FILE" 2>/dev/null || echo 0)"
fi

if [ "$(( NOW_EPOCH - LAST_EPOCH ))" -lt "$THROTTLE_SECONDS" ]; then
  echo "${STAMP} ALERT_THROTTLED unit=${UNIT_NAME} window=${THROTTLE_SECONDS}s last=${LAST_EPOCH}"
  exit 0
fi

# --- deliver -------------------------------------------------------------------
# `memphis telegram send` resolves the vault-backed bot token itself. The
# working directory is the repo so that the CLI picks up .env; the CLI also
# loads the vault reference from the vault, not from a literal in the env.
if ! command -v memphis >/dev/null 2>&1; then
  echo "${STAMP} ALERT_SEND_FAILED unit=${UNIT_NAME} reason=memphis-cli-not-found"
  exit 1
fi

SEND_OUT="$(cd "$REPO" && timeout 60 memphis telegram send --value "$MESSAGE" 2>&1)"
SEND_RC=$?

echo "$SEND_OUT"

if [ "$SEND_RC" -ne 0 ]; then
  echo "${STAMP} ALERT_SEND_FAILED unit=${UNIT_NAME} rc=${SEND_RC}"
  exit 1
fi

echo "$NOW_EPOCH" > "$THROTTLE_FILE"
echo "${STAMP} ALERT_SENT unit=${UNIT_NAME}"
exit 0
