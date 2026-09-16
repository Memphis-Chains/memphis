#!/usr/bin/env bash
# scripts/usb-virtualcam-bridge.sh
# Tier-0 helper (po załadowaniu v4l2loopback): routuje fizyczne USB video
# na virtualną kamerę, którą Telegram (przez PipeWire) zobaczy.
#
# Użycie:
#   bash scripts/usb-virtualcam-bridge.sh [SRC] [DST] [WIDTH] [HEIGHT] [FPS]
#   SRC  : /dev/video0 (auto-detect jeśli nie podany — bierze najmniejszy numer)
#   DST  : /dev/video10 (default — match modules-load.d config)
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

# Auto-detect SRC jeśli nie podany (najmniejszy /dev/video*)
detect_src() {
  for v in /dev/video{0,1,2,3,4,5,6,7}; do
    [[ -e "$v" ]] && echo "$v" && return 0
  done
  return 1
}

SRC="${1:-$(detect_src || true)}"
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

# Sprawdź czy SRC wykryty
if [[ -z "$SRC" ]] || [[ ! -e "$SRC" ]]; then
  log "ERROR: brak fizycznego grabbera USB"
  log "Spodziewane urządzenia: /dev/video0 .. /dev/video7 — żadne nie istnieje"
  log "WEPNIJ GRABBER USB do portu USB 3.0 i spróbuj ponownie"
  log "Aktualny stan USB: $(lsusb | wc -l) urządzeń USB"
  lsusb | sed 's/^/  /'
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

# Właściwy bridge — czytaj z SRC, push do DST v4l2loopback (bez transkodowania
# żeby oszczędzić CPU — v4l2loopback akceptuje dowolny format)
exec ffmpeg -hide_banner -loglevel warning \
  -f v4l2 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i "$SRC" \
  -f v4l2 "$DST"
