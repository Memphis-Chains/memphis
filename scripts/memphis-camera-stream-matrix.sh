#!/usr/bin/env bash
# scripts/memphis-camera-stream-matrix.sh
# Tier-0 helper: streamuje obraz z kamery USB do pokoju Matrix przez Homeserver.
#
# Pipeline:
#   /dev/video1 (UVC, MJPEG/YUYV) → ffmpeg NVENC H.264 → segmenter → Matrix upload
#   - thumbnail JPEG co 5s wysyłany jako m.image do pokoju (domyślne)
#   - pełny strumień: opcjonalny RTMP/SFU (wymaga osobnego URL)
#
# Matrix upload (mxc://):
#   1. POST /_matrix/media/v3/upload → mxc://server/<id>
#   2. PUT /_matrix/client/v3/rooms/<id>/send/m.room.message z content.msgtype=m.image
#
# Wymagania (ENV lub vault matrix_*):
#   MATRIX_HOMESERVER_URL  https://matrix.example.org
#   MATRIX_USER_ID         @memphis:example.org
#   MATRIX_ACCESS_TOKEN    syt_xxx_yyy
#   MATRIX_ROOM_ID         !abc:example.org
#
# Bez credentials: skrypt wychodzi z kodem 3 + komunikatem gdzie je wstawić.

set -euo pipefail

DEVICE="${1:-/dev/video1}"
WIDTH="${2:-1280}"
HEIGHT="${3:-720}"
FPS="${4:-15}"
INTERVAL_S="${5:-5}"
MODE="${6:-thumbnail}"   # thumbnail | burst | single
VAULT_NAME="${MATRIX_VAULT_PREFIX:-matrix}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

# 1) Credentials: ENV > vault > fail
get_secret() {
  local key="$1"
  local val="${!key:-}"
  if [[ -n "$val" ]]; then
    echo "$val"
    return 0
  fi
  # vault read (bez passphrase — używa MEMPHIS_VAULT_PEPPER)
  if command -v memphis >/dev/null 2>&1; then
    val=$(memphis vault get "$VAULT_NAME:$key" 2>/dev/null || true)
    if [[ -n "$val" ]]; then
      echo "$val"
      return 0
    fi
    # spróbuj bez prefixu
    val=$(memphis vault get "$key" 2>/dev/null || true)
    if [[ -n "$val" ]]; then
      echo "$val"
      return 0
    fi
  fi
  return 1
}

HOMESERVER=$(get_secret MATRIX_HOMESERVER_URL || true)
USER_ID=$(get_secret MATRIX_USER_ID || true)
TOKEN=$(get_secret MATRIX_ACCESS_TOKEN || true)
ROOM_ID=$(get_secret MATRIX_ROOM_ID || true)

if [[ -z "$HOMESERVER" || -z "$USER_ID" || -z "$TOKEN" || -z "$ROOM_ID" ]]; then
  err "Brak Matrix credentials."
  cat >&2 <<'EOF'

Aby wysyłać stream do Matrix, dodaj 4 wpisy w vault:

  memphis vault add matrix:MATRIX_HOMESERVER_URL
  memphis vault add matrix:MATRIX_USER_ID
  memphis vault add matrix:MATRIX_ACCESS_TOKEN
  memphis vault add matrix:MATRIX_ROOM_ID

Lub ustaw zmienne środowiskowe w .env:
  MATRIX_HOMESERVER_URL=https://matrix.example.org
  MATRIX_USER_ID=@memphis:example.org
  MATRIX_ACCESS_TOKEN=syt_xxx_yyy
  MATRIX_ROOM_ID=!abc:example.org

Jak uzyskać access_token:
  curl -X POST $HOMESERVER/_matrix/client/v3/login \
    -H 'Content-Type: application/json' \
    -d '{"type":"m.login.password","user":"...","password":"..."}'
EOF
  exit 3
fi

# 2) Walidacja kamery
if [[ ! -e "$DEVICE" ]]; then
  err "Brak $DEVICE — podłącz grabber"
  exit 4
fi

# 3) Test sygnału (1 frame probe)
log "Probe $DEVICE..."
if ! ffmpeg -hide_banner -loglevel error -f v4l2 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i "$DEVICE" -frames:v 1 -update 1 -y /tmp/memphis-stream-probe.jpg 2>&1; then
  err "Brak sygnału z $DEVICE"
  exit 5
fi
[[ -s /tmp/memphis-stream-probe.jpg ]] || { err "Pusta klatka probe"; exit 5; }
log "Sygnał OK"

# 4) Tryby
case "$MODE" in
  single)
    log "Single shot → Matrix"
    send_to_matrix() {
      local f="$1"
      local mime="image/jpeg"
      local body=$(jq -nc --arg url "$HOMESERVER" --arg t "$TOKEN" --arg f "@$f" --arg m "$mime" \
        '{msgtype:"m.image",body:"preview.jpg",info:{mimetype:$m,size:0},file:null}' 2>/dev/null || echo '{}')
      # 1) upload
      local mxc
      mxc=$(curl -sS -X POST \
        "${HOMESERVER}/_matrix/media/v3/upload?filename=preview.jpg" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: $mime" \
        --data-binary "@$f" | jq -r '.content_uri // empty')
      [[ -z "$mxc" ]] && { err "upload fail"; return 1; }
      log "Uploaded: $mxc"
      # 2) message
      local txn=$(date +%s%N)
      curl -sS -X PUT \
        "${HOMESERVER}/_matrix/client/v3/rooms/${ROOM_ID}/send/m.room.message/${txn}" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$(jq -nc --arg u "$mxc" --arg m "$mime" --arg s "$(stat -c%s "$f")" \
            '{msgtype:"m.image",body:"preview.jpg",info:{mimetype:$m,size:($s|tonumber)},url:$u}')" \
        | jq -r '.event_id // .errcode // "?"'
    }
    send_to_matrix /tmp/memphis-stream-probe.jpg
    exit $?
    ;;
  thumbnail|burst)
    log "Stream mode=$MODE interval=${INTERVAL_S}s → Matrix room $ROOM_ID"
    log "Zatrzymanie: Ctrl+C / kill %1"
    trap 'echo; log "Stream zatrzymany"; exit 0' INT TERM
    COUNT=0
    while true; do
      COUNT=$((COUNT+1))
      FRAME="/tmp/memphis-stream-${COUNT}.jpg"
      ffmpeg -y -hide_banner -loglevel error \
        -f v4l2 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i "$DEVICE" \
        -frames:v 1 -update 1 -q:v 5 "$FRAME" 2>&1 || { err "frame fail"; sleep "$INTERVAL_S"; continue; }
      [[ ! -s "$FRAME" ]] && { err "empty frame"; sleep "$INTERVAL_S"; continue; }

      # Upload + send
      MXC=$(curl -sS -X POST \
        "${HOMESERVER}/_matrix/media/v3/upload?filename=preview.jpg" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: image/jpeg" \
        --data-binary "@$FRAME" | jq -r '.content_uri // empty' || true)

      if [[ -n "$MXC" ]]; then
        SIZE=$(stat -c%s "$FRAME")
        TXN=$(date +%s%N)
        curl -sS -X PUT \
          "${HOMESERVER}/_matrix/client/v3/rooms/${ROOM_ID}/send/m.room.message/${TXN}" \
          -H "Authorization: Bearer $TOKEN" \
          -H "Content-Type: application/json" \
          -d "$(jq -nc --arg u "$MXC" --arg s "$SIZE" --arg ts "$(date -Iseconds)" \
              '{msgtype:"m.image",body:("frame #"+($ts)),info:{mimetype:"image/jpeg",size:($s|tonumber)},url:$u}')" \
          >/dev/null
        log "frame #$COUNT → mxc=$MXC"
      else
        log "frame #$COUNT upload fail"
      fi
      rm -f "$FRAME"
      sleep "$INTERVAL_S"
    done
    ;;
  *)
    err "Unknown MODE: $MODE (thumbnail|burst|single)"
    exit 2
    ;;
esac