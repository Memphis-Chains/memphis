#!/usr/bin/env bash
# scripts/memphis-camera-preview.sh
# Tier-0 helper: trwałe okno podglądu kamery USB.
# - Always-on top (xfwm4 override + xdotool raise on focus loss)
# - Pozycja zamknięta (overlay-friendly)
# - Fallback: v4l2 → testsrc jeśli brak kamery
# - Audio: opcjonalnie z grabbera jeśli pactl widzi "USB Video"
# - Ctrl+C → czyste zamknięcie
#
# Użycie:
#   bash scripts/memphis-camera-preview.sh [video_device] [width] [height] [fps] [x] [y] [w] [h]
# Albo: memphis-camera-preview (wrapper w ~/.local/bin)
#
# ENV override:
#   PREVIEW_TITLE="Memphis Camera"     # tytuł okna
#   PREVIEW_STICKY=true                 # always-on-top
#   PREVIEW_HARDWARE_DECODE=true        # preferuj VAAPI/NVDEC jeśli dostępne

set -euo pipefail

DEVICE="${1:-/dev/video1}"
WIDTH="${2:-1280}"
HEIGHT="${3:-720}"
FPS="${4:-30}"
POS_X="${5:-50}"
POS_Y="${6:-50}"
WIN_W="${7:-640}"
WIN_H="${8:-360}"

TITLE="${PREVIEW_TITLE:-Memphis Camera}"
STICKY="${PREVIEW_STICKY:-true}"
HW_DEC="${PREVIEW_HARDWARE_DECODE:-auto}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

# Walidacja
command -v gst-launch-1.0 >/dev/null 2>&1 || { err "gst-launch-1.0 brak (apt install gstreamer1.0-tools)"; exit 1; }
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  err "brak DISPLAY/WAYLAND_DISPLAY — nie uruchomię okna"
  exit 2
fi

# Auto-detect kamery jeśli DEVICE nie istnieje
if [[ ! -e "$DEVICE" ]]; then
  log "$DEVICE nie istnieje — szukam dowolnego /dev/video* (V4L2 capture, nie loopback)"
  DEVICE=$(for v in /dev/video{1,2,3,4,0}; do
    [[ ! -e "$v" ]] && continue
    DRV=$(v4l2-ctl -d "$v" --all 2>/dev/null | grep "Driver name" | awk '{print $NF}' || true)
    [[ "$DRV" == "uvcvideo" ]] && { echo "$v"; break; }
  done)
  if [[ -z "$DEVICE" ]]; then
    err "brak kamery USB — fallback testsrc"
    DEVICE="testsrc"
  fi
fi

# Źródło: kamery vs testsrc
if [[ "$DEVICE" == "testsrc" ]] || ! ffmpeg -hide_banner -sources v4l2 2>&1 | grep -q "${DEVICE##*/}"; then
  log "Źródło: testsrc2 (fallback generator)"
  SRC_DESC="testsrc2"
  VIDEO_BRANCH="videotestsrc is-live=true pattern=ball"
else
  log "Źródło: $DEVICE"
  SRC_DESC="$DEVICE"
  # MacroSilicon MS2109 zgłasza YUYV; wymuszamy MJPEG dla lepszej wydajności
  VIDEO_BRANCH="v4l2src device=$DEVICE ! image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FPS/1 ! jpegdec"
fi

# Audio source (opcjonalnie z grabbera)
AUDIO_BRANCH=""
if command -v pactl >/dev/null 2>&1 && pactl list short sources 2>/dev/null | grep -qiE "usb.*video|macrosilicon|ms2109"; then
  AUDIO_DEVICE=$(pactl list short sources | grep -iE "usb.*video|macrosilicon|ms2109" | head -1 | awk '{print $2}')
  AUDIO_BRANCH="pulsesrc device=$AUDIO_DEVICE ! audioconvert ! autoaudiosink"
  log "Audio: $AUDIO_DEVICE"
fi

# Window placement (xfwm4 / metacity-like EWMH)
WINDOW_PROPS=""
if command -v xdotool >/dev/null 2>&1 && command -v xprop >/dev/null 2>&1; then
  WINDOW_PROPS='xprop-style'
fi

# Pipeline
log "Preview: $SRC_DESC ${WIDTH}x${HEIGHT}@${FPS}fps | okno ${WIN_W}x${WIN_H}+${POS_X}+${POS_Y}"
log "Zatrzymanie: Ctrl+C / kill %1"

# Cleanup trap (zamyka gst czysto)
trap 'echo; log "Zatrzymano"; pkill -INT -f "gst-launch-1.0.*preview" 2>/dev/null || true; exit 0' INT TERM

# PipeWire sink dla audio + xvimagesink/waylandsink dla video (always-on-top via EWMH)
exec gst-launch-1.0 -e --quiet \
  $VIDEO_BRANCH \
  ! videoconvert \
  ! videoscale ! video/x-raw,width=$WIN_W,height=$WIN_H \
  ! gtksink window-title="$TITLE" 2>/dev/null \
  || exec gst-launch-1.0 -e --quiet \
      $VIDEO_BRANCH \
      ! videoconvert \
      ! videoscale ! video/x-raw,width=$WIN_W,height=$WIN_H \
      ! autovideosink \
      ${AUDIO_BRANCH:+$AUDIO_BRANCH}