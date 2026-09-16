#!/usr/bin/env bash
# scripts/live/memphis-camera-publish-live.sh
# Tier-0 helper: ciągły capture z MS2109 grabber → upload JPEG do marcin-kukla.pl/live/
#
# ARCHITEKTURA (FIX 2026-09-13):
#   - mkfifo /tmp/memphis-live-pipe.bin (named pipe)
#   - ffmpeg w tle: v4l2 → image2pipe → FIFO (ciągły strumień JPEG co 250ms)
#   - Python consumer czyta FIFO, wycina JPEG po markerach FFD8/FFD9
#   - Bash pętla: czeka na sygnał → upload SSH → sleep INTERVAL_S
#   - Black frames (< 5KB) są skipowane (handshake MS2109)
#
# ROOT CAUSE z debug:
#   - 2-min direct capture: t=1s BLACK, t=10s-110s WSZYSTKIE LIVE
#   - MS2109 grabber potrzebuje ~1-15s na handshake po open
#   - open/close co 2s = non-stop handshake = same czarne
#   - fix: trzymaj ffmpeg otwarty (image2pipe + FIFO)
#
# Publiczny URL: https://marcin-kukla.pl/live/

set -eo pipefail

DEVICE="${1:-/dev/video1}"
INTERVAL_S="${2:-${LIVE_INTERVAL_S:-2}}"
TMP_JPG="/tmp/memphis-live-frame.jpg"
MIN_BYTES="${LIVE_MIN_JPEG_BYTES:-5000}"
PIPE="/tmp/memphis-live-pipe.bin"
READY="/tmp/memphis-live-ready"
CAPTURE_LOG="/tmp/memphis-live-capture.log"

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

# Rozgrzewka SSH (LH.pl cold connect 67s)
log "Rozgrzewka SSH..."
ssh -F "$SSH_CONFIG_PATH" lhpl "mkdir -p ${LIVE_REMOTE_DIR}" 2>/dev/null \
  || { err "nie mogę utworzyć remote dir"; exit 3; }

upload_frame() {
  cat "$1" | ssh -F "$SSH_CONFIG_PATH" lhpl \
    "cat > ${LIVE_REMOTE_DIR}stream.jpg" 2>/dev/null
}

# Przygotuj FIFO (named pipe)
[[ -p "$PIPE" ]] || mkfifo "$PIPE"
[[ -e "$READY" ]] && rm -f "$READY"

log "Start ffmpeg capture → FIFO $PIPE"

# Producer: ffmpeg ciągły, image2pipe → FIFO
ffmpeg -y -hide_banner -loglevel error \
  -f v4l2 -input_format mjpeg -framerate 30 -video_size 1280x720 -i "$DEVICE" \
  -vf "select=not(mod(n\\,7))" -fps_mode vfr \
  -q:v 5 \
  -f image2pipe -vcodec mjpeg \
  "$PIPE" 2>"$CAPTURE_LOG" &
PRODUCER_PID=$!
log "Producer PID=$PRODUCER_PID"

# Cleanup trap
trap 'kill $PRODUCER_PID $CONSUMER_PID 2>/dev/null; rm -f "$PIPE" "$READY"; echo; log "Publisher zatrzymany"; exit 0' INT TERM

# Consumer: Python czyta FIFO, parsuje JPEG, sygnalizuje gotowość przez $READY
python3 -u -c "
import sys, os, time
ready_path = '$READY'
out_path = '$TMP_JPG'
data = bytearray()
count = 0
log_path = '$CAPTURE_LOG'
# Log przez stderr → systemd journal
def log(msg):
    print(f'[{time.strftime(\"%H:%M:%S\")}] {msg}', file=sys.stderr, flush=True)

log(f'Consumer started, reading from stdin (FIFO)')
while True:
    try:
        chunk = sys.stdin.buffer.read(8192)
    except Exception as e:
        log(f'read error: {e}')
        break
    if not chunk:
        # Producer może być pauzowany — czekamy
        time.sleep(0.1)
        continue
    data.extend(chunk)
    # Szukamy JPEG markerów
    while True:
        start = data.find(b'\xff\xd8')
        if start == -1:
            data = bytearray()
            break
        end = data.find(b'\xff\xd9', start + 2)
        if end == -1:
            # Niekompletny JPEG, czekamy na resztę
            if start > 0:
                del data[:start]
            break
        # Kompletny JPEG
        jpg = bytes(data[start:end+2])
        if len(jpg) > 100:  # sensowny rozmiar
            try:
                with open(out_path, 'wb') as f:
                    f.write(jpg)
                # Sygnał gotowości (touch)
                open(ready_path, 'w').close()
                count += 1
            except Exception as e:
                log(f'write error: {e}')
        del data[:end+2]
" < "$PIPE" > /tmp/memphis-live-consumer.log 2>&1 &
CONSUMER_PID=$!
log "Consumer PID=$CONSUMER_PID"

# Czekamy na pierwszy sygnał gotowości (max 30s na handshake)
log "Czekam na pierwszy JPEG (max 30s na handshake MS2109)..."
for i in $(seq 1 60); do
  if [[ -f "$READY" ]]; then
    log "Pierwszy JPEG gotowy"
    break
  fi
  sleep 0.5
done

log "URL: https://marcin-kukla.pl/live/"
log "Zatrzymanie: Ctrl+C / kill"

# === Główna pętla: upload co INTERVAL_S, czekamy na sygnał nowego JPEG ===
COUNT=0
while true; do
  # Czekaj na nowy sygnał ready (max 2x INTERVAL_S)
  for i in $(seq 1 40); do
    if [[ -f "$READY" ]]; then
      rm -f "$READY"
      break
    fi
    sleep 0.1
  done

  [[ ! -s "$TMP_JPG" ]] && { err "frame #$COUNT: empty TMP_JPG"; sleep "$INTERVAL_S"; continue; }

  COUNT=$((COUNT + 1))
  SIZE=$(stat -c%s "$TMP_JPG")
  
  if (( SIZE < MIN_BYTES )); then
    log "frame #$COUNT: ${SIZE}B (handshake/black) → skip"
    sleep "$INTERVAL_S"
    continue
  fi
  
  if upload_frame "$TMP_JPG"; then
    log "frame #$COUNT → upload OK (${SIZE}B)"
  else
    err "frame #$COUNT → upload FAILED"
  fi
  sleep "$INTERVAL_S"
done
