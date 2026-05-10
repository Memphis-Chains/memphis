#!/usr/bin/env bash
# Memphis voice-stack reboot survival installer.
#
# `scripts/voice-install.sh` puts Whisper STT + Piper TTS up via nohup.
# That works for the current session but DOES NOT survive a reboot. This
# script wraps the same servers as systemd user units so they start at
# login (with `linger=yes`, persistently after first login).
#
# Idempotent. Safe to re-run. Doesn't touch the venv / piper binary —
# expect `voice-install.sh` to have already populated them.
#
# Usage:
#   bash scripts/voice-systemd-install.sh           # install + enable + start
#   bash scripts/voice-systemd-install.sh --status  # show systemd state
#   bash scripts/voice-systemd-install.sh --stop    # stop both
#   bash scripts/voice-systemd-install.sh --remove  # disable + remove unit files
#
# Prerequisites:
#   - `bash scripts/voice-install.sh` ran at least once successfully
#   - Whisper venv: ~/.cache/whisper-server-venv/ exists with faster_whisper
#     (requires sudo apt install python3-venv matching active python)
#   - Piper binary: ~/piper/piper exists
#   - User systemd active (Linux desktops have this by default)

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="${REPO_ROOT}/scripts/systemd"
DEST_DIR="${HOME}/.config/systemd/user"
SERVER_DIR="${HOME}/.local/share/memphis/voice-server"
WHISPER_UNIT="memphis-whisper-stt.service"
PIPER_UNIT="memphis-piper-tts.service"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*"; }

usage() {
  cat <<EOF
Usage: $0 [--status | --stop | --remove]

Installs systemd user units for Memphis voice stack so they survive reboot.
Default action (no flag): install + enable + start.

Run \`bash scripts/voice-install.sh\` first to populate venv + piper.
EOF
}

ensure_linger() {
  if loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    ok "linger already enabled for $USER"
  else
    warn "linger NOT enabled — units won't start on boot if you're not logged in"
    warn "  fix: sudo loginctl enable-linger $USER"
  fi
}

copy_servers() {
  mkdir -p "${SERVER_DIR}"
  if [[ -f "/tmp/memphis-piper-server.py" ]]; then
    cp -n "/tmp/memphis-piper-server.py" "${SERVER_DIR}/piper-server.py" 2>/dev/null || true
    ok "piper-server.py at ${SERVER_DIR}/"
  fi
  if [[ -f "/tmp/memphis-whisper-server.py" ]]; then
    cp -n "/tmp/memphis-whisper-server.py" "${SERVER_DIR}/whisper-server.py" 2>/dev/null || true
    ok "whisper-server.py at ${SERVER_DIR}/"
  fi
  if [[ ! -f "${SERVER_DIR}/piper-server.py" || ! -f "${SERVER_DIR}/whisper-server.py" ]]; then
    fail "missing server scripts at ${SERVER_DIR}/"
    fail "  run \`bash ${REPO_ROOT}/scripts/voice-install.sh\` first to generate them"
    exit 1
  fi
}

install_unit() {
  local name="$1"
  local src="${TEMPLATE_DIR}/${name}"
  local dst="${DEST_DIR}/${name}"
  if [[ ! -f "$src" ]]; then
    fail "template missing: $src"
    exit 1
  fi
  cp "$src" "$dst"
  ok "installed unit ${name} at ${dst}"
}

action_install() {
  step "Pre-flight"
  if [[ ! -d "${HOME}/piper" ]]; then
    warn "piper binary not found at ${HOME}/piper/ — TTS will fail to start"
    warn "  run scripts/voice-install.sh first to download piper + voices"
  fi
  if [[ ! -x "${HOME}/.cache/whisper-server-venv/bin/python3" ]]; then
    warn "whisper venv missing/broken at ${HOME}/.cache/whisper-server-venv/"
    warn "  fix: sudo apt install python3-venv && bash scripts/voice-install.sh"
  fi
  ensure_linger

  step "Copy server scripts to persistent location"
  copy_servers

  step "Install systemd user units"
  mkdir -p "${DEST_DIR}"
  install_unit "${PIPER_UNIT}"
  install_unit "${WHISPER_UNIT}"

  step "systemctl daemon-reload"
  systemctl --user daemon-reload
  ok "reloaded"

  step "Enable + start"
  systemctl --user enable --now "${PIPER_UNIT}" 2>&1 | tail -2
  systemctl --user enable "${WHISPER_UNIT}" 2>&1 | tail -2
  # Try start whisper too — if venv broken it'll fail and Restart= retries
  systemctl --user start "${WHISPER_UNIT}" 2>/dev/null || true

  step "Verify"
  for unit in "${PIPER_UNIT}" "${WHISPER_UNIT}"; do
    state=$(systemctl --user is-active "${unit}" 2>/dev/null || echo "unknown")
    enabled=$(systemctl --user is-enabled "${unit}" 2>/dev/null || echo "unknown")
    if [[ "$state" == "active" ]]; then
      ok "${unit}: ${state}, ${enabled}"
    else
      warn "${unit}: ${state}, ${enabled}"
    fi
  done
}

action_status() {
  for unit in "${PIPER_UNIT}" "${WHISPER_UNIT}"; do
    echo "=== ${unit} ==="
    systemctl --user status --no-pager "${unit}" 2>&1 | head -15
    echo
  done
}

action_stop() {
  systemctl --user stop "${PIPER_UNIT}" "${WHISPER_UNIT}" 2>&1 | tail -2
  ok "stopped"
}

action_remove() {
  systemctl --user disable --now "${PIPER_UNIT}" "${WHISPER_UNIT}" 2>&1 | tail -2 || true
  rm -f "${DEST_DIR}/${PIPER_UNIT}" "${DEST_DIR}/${WHISPER_UNIT}"
  systemctl --user daemon-reload
  ok "removed"
}

case "${1:-}" in
  ""|"--install") action_install ;;
  "--status")     action_status ;;
  "--stop")       action_stop ;;
  "--remove")     action_remove ;;
  "-h"|"--help")  usage ;;
  *) usage; exit 1 ;;
esac
