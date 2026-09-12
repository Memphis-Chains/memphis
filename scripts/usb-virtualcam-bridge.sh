#!/usr/bin/env bash
# scripts/usb-virtualcam-bridge.sh
# Tier-0 helper (po załadowaniu v4l2loopback): routuje fizyczne USB video
# na virtualną kamerę, którą Telegram (przez PipeWire) zobaczy.
#
# Użycie:
#   bash scripts/usb-virtualcam-bridge.sh [SRC] [DST] [WIDTH] [HEIGHT] [FPS]
#   SRC  : /dev/video0 (fizyczny grabber; default)
#   DST  : /dev/video10 (v4l2loopback slot; default — match modules-load.d config)
#   WxH  : 1280x720 (default)
#   FPS  : 30 (default)
#
# Wymagania:
#   - moduł v4l2loopback załadowany z takim samym video_nr jak DST
#   - ffmpeg z obsługą v4l2 (jest domyślnie w 7.1.1)
#   - Dla wejścia: fizyczny grabber USB (UVC, HDMI grabber itp.)
#
# Zatrzymanie: Ctrl+C (ffmpeg wyłączy się czysto)

set -euo pipefail

SRC="${1:-/dev/video0}"
DST="${2:-/dev/video10}"
WIDTH="${3:-1280}"
HEIGHT="${4:-720}"
FPS="${5:-30}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Walidacja: czy DST to v4l2loopback?
if [[ ! -e "$DST" ]]; then
  log "ERROR: $DST nie istnieje — v4l2loopback nie załadowany LUB zły numer video_nr"
  log "Sprawdź:  lsmod | grep v4l2loopback"
  log "Załaduj:  sudo modprobe v4l2loopback devices=2 video_nr=10,11 card_label='Ripper USB 0','Ripper USB 1' exclusive_caps=0,0"
  exit 1
fi

# Sprawdź czy SRC istnieje
if [[ ! -e "$SRC" ]]; then
  log "WARNING: $SRC nie istnieje — fizyczny grabber nie podłączony"
  log "Podłącz grabber USB lub podaj inną ścieżkę jako argument 1"
  exit 1
fi

# Opcjonalnie sprawdź v4l2-ctl capabilities jeśli dostępne
if command -v v4l2-ctl >/dev/null 2>&1; then
  log "SRC info: $(v4l2-ctl -d "$SRC" --info 2>&1 | grep -E 'Driver|Card' | head -2 || echo 'unknown')"
  log "DST info: $(v4l2-ctl -d "$DST" --info 2>&1 | grep -E 'Driver|Card' | head -2 || echo 'unknown')"
else
  log "TIP: zainstaluj 'sudo apt install v4l-utils' dla diagnostyki capabilities"
fi

log "Bridge start: $SRC → $DST  (${WIDTH}x${HEIGHT}@${FPS}fps)"
log "Zatrzymanie: Ctrl+C"

# Cleanup trap
trap 'echo; log "Zatrzymano (Ctrl+C)"; exit 0' INT TERM

# Właściwy bridge — czytaj z SRC, dekoduj do raw, koduj NVENC H264, push do DST v4l2
# Wymuszenie rozdzielczości i FPS (nie wszystkie grabbery je ustawiają)
# NVENC H264 dla niskiego CPU; gdyby nie zadziałało — `libx264 -preset ultrafast`
exec ffmpeg -hide_banner -loglevel warning \
  -f v4l2 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i "$SRC" \
  -f v4l2 "$DST"
