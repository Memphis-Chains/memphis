#!/bin/bash
# play.sh — odpal wideo z assets w tle, w X11 lokalnym
# Użycie: ./play.sh <ścieżka-do-pliku> [--loop]
#
# Wymagania: $DISPLAY=:0.0 (lokalne X11), user ma .Xauthority, players: vlc|mpv|ffplay
set +e

FILE="$1"
LOOP_FLAG=""
[ "$2" = "--loop" ] && LOOP_FLAG="--loop"

if [ -z "$FILE" ]; then
  echo "usage: $0 <file.mp4> [--loop]"
  exit 64
fi
if [ ! -f "$FILE" ]; then
  echo "FAIL: plik nie istnieje: $FILE"
  exit 66
fi

# Sprawdz czy X11 lokalne i mozemy sie polaczyc
if [ -z "$DISPLAY" ] || ! timeout 2 xdpyinfo >/dev/null 2>&1; then
  echo "FAIL: brak X11 / DISPLAY=$DISPLAY niedostepne"
  exit 70
fi

# Preferuj mpv (lekki), potem vlc, potem ffplay
PLAYER=""
if command -v mpv >/dev/null 2>&1; then
  PLAYER="mpv"
  LOOP_FLAG="--loop=inf"
elif command -v vlc >/dev/null 2>&1; then
  PLAYER="vlc"
  LOOP_FLAG="--loop"
elif command -v ffplay >/dev/null 2>&1; then
  PLAYER="ffplay"
  LOOP_FLAG="-loop 0"
else
  echo "FAIL: brak playerow (mpv/vlc/ffplay)"
  exit 71
fi

LOG="/tmp/${PLAYER}-skill-$$.log"
cd "$(dirname "$FILE")"  # CRITICAL: runtime quirk - abs path /home/.../file czasem "nie istnieje"
BASENAME="$(basename "$FILE")"

# setsid -f odpina od biezacego shella - PID przechodzi na init
setsid -f "$PLAYER" $LOOP_FLAG "$BASENAME" >"$LOG" 2>&1 </dev/null
RC=$?
sleep 3

if pgrep -f "$PLAYER.*$BASENAME" >/dev/null; then
  PID=$(pgrep -f "$PLAYER.*$BASENAME" | head -1)
  echo "OK: $PLAYER gra (PID=$PID) plik=$FILE log=$LOG"
  echo "Aby zatrzymac: kill $PID  lub  pkill -f $PLAYER"
  exit 0
else
  echo "FAIL: $PLAYER wystartowal ale znikl po 3s"
  echo "--- log ---"
  tail -20 "$LOG"
  exit 72
fi
