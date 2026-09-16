#!/usr/bin/env bash
# scripts/obs-nvenc-record.sh
# Tier-0 autonomous recording helper: nagrywanie z /dev/videoX (V4L2)
# z fallbackiem do testsrc2 jeśli brak kamery. Sprzętowe kodowanie NVENC H.264.
#
# Użycie:
#   bash scripts/obs-nvenc-record.sh [DEVICE] [DURATION_S] [OUTFILE]
#   DEVICE    : /dev/video0 (default)
#   DURATION_S: 5 (default)
#   OUTFILE   : /tmp/capture-$(date +%s).mp4 (default)
#
# Exit 0 = sukces + plik gotowy
# Exit 1 = NVENC nieosiągalny
# Exit 2 = ffmpeg fail

set -euo pipefail

DEVICE="${1:-/dev/video0}"
DUR="${2:-5}"
OUT="${3:-/tmp/capture-$(date +%s).mp4}"

log() { echo "[$(date +%H:%M:%S)] $*"; }


# Weryfikacja urządzenia
SOURCE="testsrc"
if [[ -e "$DEVICE" ]] && ffmpeg -hide_banner -sources v4l2 2>&1 | grep -q "${DEVICE##*/}"; then
  SOURCE="v4l2"
  log "Źródło: $DEVICE (V4L2 capture)"
else
  log "INFO: $DEVICE nieosiągalne — fallback do testsrc (generator wzorcowy)"
fi

# Nagrywanie
log "Start recording: ${DUR}s → $OUT"
if [[ "$SOURCE" == "v4l2" ]]; then
  ffmpeg -y -hide_banner -loglevel warning \
    -f v4l2 -framerate 30 -video_size 1280x720 -i "$DEVICE" \
    -f alsa -i hw:0,0 \
    -t "$DUR" \
    -c:v h264_nvenc -preset p4 -b:v 4M \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    "$OUT"
else
  ffmpeg -y -hide_banner -loglevel warning \
    -f lavfi -i "testsrc2=size=1280x720:rate=30" \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
    -t "$DUR" \
    -c:v h264_nvenc -preset p4 -b:v 4M \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    "$OUT"
fi

# Weryfikacja
if [[ -f "$OUT" ]] && [[ -s "$OUT" ]]; then
  SIZE=$(du -h "$OUT" | cut -f1)
  log "OK: $OUT ($SIZE)"
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration "$OUT"
  exit 0
else
  log "ERROR: plik nie powstał lub jest pusty"
  exit 2
fi
# Weryfikacja NVENC (count pattern match, robust z pipefail)
HAS_NVENC=$(ffmpeg -hide_banner -encoders 2>&1 | grep -cE "^\s+V\S+\s+h264_nvenc\s+" || true)
if [[ "${HAS_NVENC:-0}" -lt 1 ]]; then
  log "ERROR: h264_nvenc encoder niedostępny (count=$HAS_NVENC)"
  exit 1
fi