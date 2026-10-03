#!/usr/bin/env bash
# Memphis BASAL-1.0 typed-decision server installer.
#
#   BASAL  basal-1.0-1.5B → http://127.0.0.1:8000/v1/systemone  (CPU only)
#
# BASAL answers a typed question about a state (choice / noul / score)
# with a calibrated probability per option — no generated text, nothing
# to parse, and a confidence you can threshold. Categories are described
# per request, so one model serves many taxonomies without retraining.
#
# SLOW BY DESIGN ON THIS HOST. The model is 1.5B parameters; on a GPU
# with a supported kernel it answers in 12-25 ms. On a host whose CUDA
# card torch no longer ships kernels for, it runs on CPU at ~70 s per
# decision (orders=1) or ~140 s (orders=2). Install this for batch and
# offline triage, not for interactive loops. The tool description says
# so too — this installer cannot change the hardware.
#
#   One-shot:              bash scripts/install-basal.sh
#   Restart servers only:  bash scripts/install-basal.sh --restart
#   Stop servers:          bash scripts/install-basal.sh --stop
#   Force reinstall:       bash scripts/install-basal.sh --force
#   Other install root:    MEMPHIS_BASAL_DIR=/opt/basal bash scripts/install-basal.sh
#
# Idempotent: safe to re-run, skips anything already in place. Does NOT
# touch your `.env` and does NOT enable the systemd unit unless you pass
# --enable-service. Start that way deliberately — the model holds ~1 GB
# of weights in page cache and eats a core while it answers.

set -uo pipefail

# Resolve the repo root first: `set -u` makes a forward reference abort
# with "unbound variable" instead of expanding to an empty path.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASAL_DIR="${MEMPHIS_BASAL_DIR:-$HOME/.local/share/basal}"
VENV="$BASAL_DIR/venv"
SRC="$BASAL_DIR/src"
SERVER="$BASAL_DIR/basal_cpu.py"
LOG="${MEMPHIS_BASAL_LOG:-$HOME/.memphis/logs/basal-server.log}"
PORT="${BASAL_PORT:-8000}"
UNIT="memphis-basal-td.service"
PYTHON_VERSION="${MEMPHIS_BASAL_PYTHON:-3.12}"
MODEL_REPO="${MEMPHIS_BASAL_MODEL:-Remek/basal-1.0-1.5B}"
BASAL_VERSION="${MEMPHIS_BASAL_VERSION:-v1.0.1}"
FORCE=0
ENABLE_SERVICE=0

if [[ ! -d "$ROOT_DIR/scripts" ]]; then
  echo "[basal] run me from the repo: bash scripts/install-basal.sh" >&2
  exit 1
fi

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --enable-service) ENABLE_SERVICE=1 ;;
    --restart) RESTART=1 ;;
    --stop) STOP=1 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "[basal] unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[basal] %s\n' "$*"; }
die() { printf '[basal] ERROR: %s\n' "$*" >&2; exit 1; }

UNIT_SRC="$ROOT_DIR/scripts/systemd/$UNIT"

server_pid() { pgrep -f "basal_cpu.py" 2>/dev/null | head -1; }
server_health() {
  curl -s -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null
}

stop_server() {
  if command -v systemctl >/dev/null 2>&1 \
     && systemctl --user is-active "$UNIT" >/dev/null 2>&1; then
    log "stopping systemd unit $UNIT"
    systemctl --user stop "$UNIT" 2>/dev/null
  fi
  local pid
  pid="$(server_pid)"
  if [[ -n "${pid:-}" ]]; then
    log "stopping stray pid $pid"
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 15); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
}

if [[ "${STOP:-0}" == "1" ]]; then
  stop_server
  log "stopped"
  exit 0
fi

command -v uv >/dev/null 2>&1 || die "uv not found — install from https://docs.astral.sh/uv/ or set MEMPHIS_BASAL_PYTHON and install manually"
command -v curl >/dev/null 2>&1 || die "curl not found"

mkdir -p "$BASAL_DIR" "$HOME/.memphis/logs"

# ── 1. venv ────────────────────────────────────────────────────────────
if [[ "$FORCE" == "1" ]]; then
  log "--force: removing existing venv and source"
  rm -rf "$VENV" "$SRC"
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  log "creating venv ($VENV) on Python $PYTHON_VERSION"
  uv venv --python "$PYTHON_VERSION" "$VENV" >/dev/null 2>&1 \
    || die "uv venv failed. Install Python $PYTHON_VERSION or set MEMPHIS_BASAL_PYTHON."
else
  log "venv present: $VENV"
fi

# ── 2. dependencies ────────────────────────────────────────────────────
# CPU torch on purpose. A CUDA build is 2+ GB and still would not run on
# a card torch has no kernels for; bfloat16 on CPU loads in ~1 s and
# holds ~0.4 GB, while float32 OOMs on a 15 GB host with Memphis resident.
if ! "$VENV/bin/python" -c "import torch, transformers, basal" >/dev/null 2>&1; then
  log "installing CPU torch (this takes a few minutes on a cold cache)"
  uv pip install --python "$VENV/bin/python" torch \
    --index-url https://download.pytorch.org/whl/cpu >/dev/null 2>&1 \
    || die "torch install failed"
  log "installing basal runtime deps"
  uv pip install --python "$VENV/bin/python" \
    "transformers==5.17.0" "huggingface_hub>=0.34" "accelerate>=1.10" \
    "safetensors>=0.6" "starlette>=0.47" "uvicorn[standard]>=0.35" \
    "httpx>=0.28" fastapi numpy >/dev/null 2>&1 \
    || die "runtime dependency install failed"
else
  log "runtime deps present"
fi

# ── 3. source ──────────────────────────────────────────────────────────
if [[ ! -d "$SRC/basal" ]]; then
  log "fetching basal $BASAL_VERSION"
  tmp_tar="$(mktemp)"
  curl -sL "https://github.com/rkinas/basal/archive/refs/tags/${BASAL_VERSION}.tar.gz" \
    -o "$tmp_tar" || { rm -f "$tmp_tar"; die "download failed"; }
  mkdir -p "$SRC"
  tar xzf "$tmp_tar" -C "$SRC" --strip-components=1 || { rm -f "$tmp_tar"; die "extract failed"; }
  rm -f "$tmp_tar"
  log "installing basal package into venv"
  uv pip install --python "$VENV/bin/python" "$SRC" >/dev/null 2>&1 \
    || die "basal package install failed"
else
  log "source present: $SRC"
fi

# ── 4. model weights ───────────────────────────────────────────────────
if ! "$VENV/bin/python" -c "
from huggingface_hub import snapshot_download
import sys
try:
    snapshot_download('$MODEL_REPO', local_files_only=True)
except Exception:
    sys.exit(1)
" >/dev/null 2>&1; then
  log "downloading $MODEL_REPO (~3.2 GB, several minutes)"
  "$VENV/bin/python" -c "
from huggingface_hub import snapshot_download
print(snapshot_download('$MODEL_REPO'))
" >/dev/null 2>&1 || die "model download failed"
else
  log "model weights cached"
fi

# ── 5. server script ───────────────────────────────────────────────────
# The server lives in the repo (scripts/basal/basal_cpu.py) and is copied
# into the install root. It used to exist only under ~/.local/share, which
# made a clean host fail the install that --help advertises as one-shot.
SERVER_SRC="$ROOT_DIR/scripts/basal/basal_cpu.py"
if [[ ! -f "$SERVER_SRC" ]]; then
  die "server source missing: $SERVER_SRC"
fi
if ! cmp -s "$SERVER_SRC" "$SERVER" 2>/dev/null; then
  log "installing server script"
  cp "$SERVER_SRC" "$SERVER"
  chmod +x "$SERVER"
fi

# ── 6. systemd unit ────────────────────────────────────────────────────
if [[ "$ENABLE_SERVICE" == "1" ]]; then
  if [[ -f "$UNIT_SRC" ]]; then
    mkdir -p "$HOME/.config/systemd/user"
    cp "$UNIT_SRC" "$HOME/.config/systemd/user/$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT" >/dev/null 2>&1 \
      && log "systemd unit enabled and started" \
      || log "systemd unit installed but failed to start — check: systemctl --user status $UNIT"
  else
    log "unit file missing at $UNIT_SRC — skipping service install"
  fi
fi

# ── 7. start ───────────────────────────────────────────────────────────
if [[ "${RESTART:-0}" == "1" ]]; then
  stop_server
fi

if [[ -z "$(server_pid)" ]]; then
  log "starting server on port $PORT"
  ( cd "$BASAL_DIR" && setsid "$VENV/bin/python" "$SERVER" >>"$LOG" 2>&1 < /dev/null & )
  for _ in $(seq 1 60); do
    if curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ready":true'; then
      log "ready"
      break
    fi
    sleep 2
  done
fi

HEALTH="$(server_health)"
if [[ -z "$HEALTH" ]]; then
  printf '\n'
  printf '────────────────────────────────────────────────────────────\n'
  printf 'Server did NOT answer on http://127.0.0.1:%s/health\n' "$PORT"
  printf 'Log: tail -f %s\n' "$LOG"
  printf 'The model takes ~1-3 s to load; give it a moment and re-check.\n'
  printf '────────────────────────────────────────────────────────────\n'
  exit 1
fi

printf '\n'
printf '────────────────────────────────────────────────────────────\n'
printf 'Install root: %s\n' "$BASAL_DIR"
printf 'Model:        %s (bfloat16, cpu)\n' "$MODEL_REPO"
printf 'PID:          %s\n' "$(server_pid)"
printf 'Service:      systemctl --user status %s\n' "$UNIT"
printf '\n'
printf 'Check health: curl -s http://127.0.0.1:%s/health\n' "$PORT"
printf 'Log:          tail -f %s\n' "$LOG"
printf 'Restart:      bash scripts/install-basal.sh --restart\n'
printf 'Stop:         bash scripts/install-basal.sh --stop\n'
printf '\n'
printf 'memphis_classify is registered but not required. With the server\n'
printf 'down it returns a structured "unreachable" error plus the start\n'
printf 'command. Latency on this host is ~70-140 s per decision.\n'
printf '────────────────────────────────────────────────────────────\n'
