#!/usr/bin/env bash
# scripts/live/memphis-camera-publish-live.sh
# Tier-0 helper: cyklicznie uploaduje JPEG do marcin-kukla.pl/live/stream.jpg
#
# Pipeline:
#   1. ffmpeg z /dev/video1 (MS2109) → JPEG 1280x720 quality 5
#      Fallback do testsrc2 jeśli grabber bez sygnału (czarny obraz < 5KB)
#   2. ssh + cat > stream.jpg (atomic upload via stdin)
#   3. sleep INTERVAL_S, repeat
#
# Publiczny URL: https://marcin-kukla.pl/live/
#
# Użycie:
#   bash scripts/live/memphis-camera-publish-live.sh [DEVICE] [INTERVAL_S]
#   memphis-camera-publish-live (wrapper)
#
# ENV:
#   LIVE_REMOTE_USER     default: serwer437043
#   LIVE_REMOTE_HOST     default: serwer437043.lh.pl
#   LIVE_REMOTE_DIR      default: ~/public_html/marcin-kukla/live/
#   LIVE_INTERVAL_S      default: 2
#   LIVE_SSH_CONFIG      default: ~/.ssh/lhpl-active/config
#   LIVE_MIN_JPEG_BYTES  default: 5000  (poniżej = czarny ekran → fallback testsrc)

set -eo pipefail

DEVICE="${1:-/dev/video1}"
INTERVAL_S="${2:-${LIVE_INTERVAL_S:-2}}"
TMP_JPG="/tmp/memphis-live-frame.jpg"
MIN_BYTES="${LIVE_MIN_JPEG_BYTES:-5000}"

LIVE_REMOTE_USER="${LIVE_REMOTE_USER:-serwer437043}"
LIVE_REMOTE_HOST="${LIVE_REMOTE_HOST:-serwer437043.lh.pl}"
LIVE_REMOTE_DIR="${LIVE_REMOTE_DIR:-~/public_html/marcin-kukla/live/}"
LIVE_SSH_CONFIG="${LIVE_SSH_CONFIG:-~/.ssh/lhpl-active/config}"

SSH_CONFIG_PATH="${LIVE_SSH_CONFIG/#\~/$HOME}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

if ! [[ -f "$SSH_CONFIG_PATH" ]]; then
  err "SSH config nie istnieje: $SSH_CONFIG_PATH"; exit 2
fi

# Upewnij się że remote dir istnieje
ssh -F "$SSH_CONFIG_PATH" lhpl "mkdir -p ${LIVE_REMOTE_DIR}" 2>/dev/null \
  || { err "nie mogę utworzyć remote dir"; exit 3; }

upload_frame() {
  local jpg="$1"
  cat "$jpg" | ssh -F "$SSH_CONFIG_PATH" lhpl \
    "cat > ${LIVE_REMOTE_DIR}stream.jpg" 2>/dev/null
}

capture_from_device() {
  ffmpeg -y -hide_banner -loglevel error \
    -f v4l2 -framerate 30 -video_size 1280x720 -i "$DEVICE" \
    -frames:v 1 -update 1 -q:v 5 "$TMP_JPG" 2>/dev/null
}

capture_testsrc() {
  # 1280x720 ball pattern, audio sine wave, 1 klatka
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=1280x720:rate=30" \
    -frames:v 1 -update 1 -q:v 5 "$TMP_JPG" 2>/dev/null
}

log "Start publisher: $DEVICE → $LIVE_REMOTE_USER@$LIVE_REMOTE_HOST (co ${INTERVAL_S}s, threshold=${MIN_BYTES}B)"
log "URL: https://marcin-kukla.pl/live/"
log "Zatrzymanie: Ctrl+C"

trap 'echo; log "Publisher zatrzymany"; exit 0' INT TERM

COUNT=0
FALLBACK=0
while true; do
  COUNT=$((COUNT + 1))

  # 1. capture (preferuj kamerę, fallback do testsrc jeśli JPEG za mały = czarny)
  SOURCE="device"
  if ! capture_from_device; then
    err "frame #$COUNT: device capture failed → testsrc fallback"
    capture_testsrc || { err "testsrc też nie zadziałał"; sleep "$INTERVAL_S"; continue; }
    SOURCE="testsrc"
    FALLBACK=1
  else
    SIZE=$(stat -c%s "$TMP_JPG" 2>/dev/null || echo 0)
    if (( SIZE < MIN_BYTES )); then
      log "frame #$COUNT: ${SIZE}B (czarny/${SOURCE}) → testsrc fallback"
      capture_testsrc || { err "testsrc też nie zadziałał"; sleep "$INTERVAL_S"; continue; }
      SOURCE="testsrc"
      FALLBACK=1
    fi
  fi

  [[ ! -s "$TMP_JPG" ]] && { err "empty frame"; sleep "$INTERVAL_S"; continue; }

  # 2. upload
  if upload_frame "$TMP_JPG"; then
    SIZE=$(stat -c%s "$TMP_JPG")
    log "frame #$COUNT → upload OK (${SIZE}B, ${SOURCE})"
  else
    err "frame #$COUNT → upload FAILED"
  fi
  sleep "$INTERVAL_S"
done
