#!/usr/bin/env bash
# scripts/memphis-camera-preview.sh
# Tier-0 helper: trwałe okno podglądu kamery USB.
# Używa VLC (Qt interface) bo tworzy prawdziwe WM-managed okno widoczne w xwininfo.
# gstreamer xvimagesink działa ale overlay nie pojawia się w X11 query (xfwm4 composite issue).
#
# Użycie:
#   bash scripts/memphis-camera-preview.sh [video_device] [width] [height] [x] [y]
#   Albo: memphis-camera-preview (wrapper)
#
# ENV:
#   PREVIEW_TITLE       domyślnie "Memphis Camera"
#   PREVIEW_STICKY      true/false (always-on-top) — VLC ma --video-on-top
#   PREVIEW_NO_AUDIO    true żeby pominąć audio (domyślnie false)

set -euo pipefail

DEVICE="${1:-/dev/video1}"
WIN_W="${2:-640}"
WIN_H="${3:-360}"
WIN_X="${4:-1000}"
WIN_Y="${5:-50}"

TITLE="${PREVIEW_TITLE:-Memphis Camera}"
NO_AUDIO_FLAG=""
if [[ "${PREVIEW_NO_AUDIO:-false}" == "true" ]]; then
  NO_AUDIO_FLAG="--no-audio"
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

# Walidacja
command -v vlc >/dev/null 2>&1 || { err "vlc nie zainstalowany"; exit 1; }
if [[ -z "${DISPLAY:-}" ]]; then
  err "brak DISPLAY — okno nie zostanie wyświetlone"; exit 2
fi

# Auto-detect kamery
if [[ ! -e "$DEVICE" ]] || ! v4l2-ctl -d "$DEVICE" --all >/dev/null 2>&1; then
  log "$DEVICE nieosiągalne — szukam dowolnego /dev/video* (UVC)"
  DEVICE=$(for v in /dev/video{1,2,3,4,0}; do
    [[ ! -e "$v" ]] && continue
    DRV=$(v4l2-ctl -d "$v" --all 2>/dev/null | grep "Driver name" | awk '{print $NF}' || true)
    [[ "$DRV" == "uvcvideo" ]] && { echo "$v"; break; }
  done)
  [[ -z "$DEVICE" ]] && { err "brak kamery USB"; exit 4; }
fi

# Ekran (do pozycjonowania)
SCREEN_W=$(DISPLAY="$DISPLAY" xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $1}' | cut -dx -f1)
SCREEN_H=$(DISPLAY="$DISPLAY" xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $1}' | cut -dx -f2)
[[ -z "$SCREEN_W" ]] && SCREEN_W=1680
[[ -z "$SCREEN_H" ]] && SCREEN_H=1050

# Clamp pozycji żeby okno nie wyleciało poza ekran
(( WIN_X + WIN_W > SCREEN_W )) && WIN_X=$((SCREEN_W - WIN_W - 20))
(( WIN_Y + WIN_H > SCREEN_H )) && WIN_Y=$((SCREEN_H - WIN_H - 20))

log "Preview: $DEVICE ${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
log "Zatrzymanie: Ctrl+C / kill %1 / 'memphis-camera-preview-stop'"

# Cleanup trap
trap 'echo; log "Zatrzymano"; pkill -f "vlc.*memphis-camera-preview" 2>/dev/null || true; exit 0' INT TERM

exec vlc \
  --intf=qt \
  --no-qt-privacy-ask \
  --video-on-top \
  --no-qt-error-dialogs \
  --no-spu \
  $NO_AUDIO_FLAG \
  --video-title-show \
  --video-title-timeout=2000 \
  --video-title-position=0 \
  --video-title="$TITLE — $DEVICE" \
  --width="$WIN_W" --height="$WIN_H" \
  --video-x="$WIN_X" --video-y="$WIN_Y" \
  "v4l2://$DEVICE:width=1280:height=720:fps=30"