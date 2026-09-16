#!/usr/bin/env bash
# scripts/usb-grabber-display.sh
# Tier-0 helper: wyświetla obraz z grabbera USB + audio na lokalnym ekranie.
# Używa gstreamer (PipeWire dla audio) — nie wymaga instalacji.
#
# Użycie:
#   bash scripts/usb-grabber-display.sh [video_device] [width] [height] [fps]
#   Albo przez wrapper: memphis-display
#
# Zatrzymanie: Ctrl+C (gst-launch zamyka się czysto)

set -euo pipefail

DEVICE="${1:-/dev/video0}"
WIDTH="${2:-1280}"
HEIGHT="${3:-720}"
FPS="${4:-30}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Walidacja
if [[ ! -e "$DEVICE" ]]; then
  log "ERROR: $DEVICE nie istnieje — grabber nie podłączony"
  exit 1
fi

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
  log "ERROR: gst-launch-1.0 nie zainstalowany (sudo apt install gstreamer1.0-tools)"
  exit 1
fi

# Sprawdź czy X11/Wayland jest dostępny (dla autovideosink)
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  log "WARNING: brak DISPLAY/WAYLAND_DISPLAY — okno nie zostanie wyświetlone"
fi

# Znajdź audio source PipeWire dla grabbera (szukamy "USB Video")
AUDIO_SRC="autoaudiosrc"
AUDIO_DEVICE=$(pactl list short sources 2>/dev/null | grep -iE "usb.*video|macrosilicon|ms2109" | head -1 | awk '{print $2}')
if [[ -n "$AUDIO_DEVICE" ]]; then
  AUDIO_SRC="pulsesrc device=$AUDIO_DEVICE"
  log "Audio source: $AUDIO_DEVICE"
else
  log "INFO: nie znalazłem dedykowanego audio grabbera przez pactl, używam autoaudiosrc"
fi

log "Display start: $DEVICE ${WIDTH}x${HEIGHT}@${FPS}fps"
log "Zatrzymanie: Ctrl+C"
echo

# Cleanup trap
trap 'echo; log "Zatrzymano (Ctrl+C)"; exit 0' INT TERM

exec gst-launch-1.0 -e --quiet \
  v4l2src device="$DEVICE" ! "image/jpeg,width=$WIDTH,height=$HEIGHT,framerate=$FPS/1" \
  ! jpegdec ! videoconvert ! autovideosink \
  $AUDIO_SRC ! audioconvert ! autoaudiosink
