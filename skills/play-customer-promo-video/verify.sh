#!/bin/bash
# verify.sh — walidacja pliku MP4/JPG/asset i gotowości środowiska
# Użycie: ./verify.sh <ścieżka-do-pliku>
set +e

FILE="$1"

if [ -z "$FILE" ]; then
  echo "usage: $0 <file.mp4|file.jpg>"
  exit 64
fi

PASS=0
FAIL=0

ok() { echo "  PASS: $1"; PASS=$((PASS+1)); }
no() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== TEST 1: plik istnieje ==="
[ -f "$FILE" ] && ok "istnieje: $FILE" || { no "brak pliku: $FILE"; exit 66; }

echo "=== TEST 2: rozmiar > 0 ==="
SIZE=$(stat -c%s "$FILE" 2>/dev/null)
[ -n "$SIZE" ] && [ "$SIZE" -gt 0 ] && ok "size=$SIZE bytes" || no "pusty plik"

echo "=== TEST 3: magic bytes ==="
HEAD=$(head -c 16 "$FILE" | od -An -tx1 | tr -d ' \n')
case "$HEAD" in
  *000000??66747970*) KIND="mp4"; ok "ISO BMFF (mp4/mov)" ;;
  *ffd8ff*) KIND="jpg"; ok "JPEG" ;;
  *1a45dfa3*) KIND="mkv"; ok "Matroska (mkv/webm)" ;;
  *) KIND="unknown"; no "nieznany format: $HEAD" ;;
esac

echo "=== TEST 4: ffprobe parsowalnosc (per kind) ==="
if command -v ffprobe >/dev/null 2>&1; then
  if ffprobe -v error -show_entries format=duration "$FILE" >/dev/null 2>&1; then
    DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$FILE" 2>/dev/null)
    if [ "$KIND" = "jpg" ]; then
      # JPG - nie oczekuj video/audio stream, sprawdz tylko ze duration>0 (albo brak duration - wtedy OK dla static image)
      ok "JPEG readable (ffprobe duration=${DUR:-n/a}s, OK dla static)"
    elif [ "$KIND" = "mp4" ] || [ "$KIND" = "mkv" ]; then
      HAS_V=$(ffprobe -v error -select_streams v -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "$FILE" 2>/dev/null | grep -c video)
      HAS_A=$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "$FILE" 2>/dev/null | grep -c audio)
      [ "$HAS_V" -ge 1 ] && ok "video stream present" || no "brak video stream"
      [ "$HAS_A" -ge 1 ] && ok "audio stream present (duration=${DUR}s)" || ok "brak audio (duration=${DUR}s, ok)"
    fi
  else
    no "ffprobe nie sparsowal pliku"
  fi
else
  no "ffprobe nie zainstalowany"
fi

echo "=== TEST 5: X11 / display ==="
if [ -n "$DISPLAY" ] && timeout 2 xdpyinfo >/dev/null 2>&1; then
  ok "DISPLAY=$DISPLAY dziala"
else
  no "X11 niedostepne (DISPLAY=$DISPLAY)"
fi

echo "=== TEST 6: player dostepny ==="
P=""
for cand in mpv vlc ffplay parole; do
  if command -v $cand >/dev/null 2>&1; then
    P="$cand"
    break
  fi
done
[ -n "$P" ] && ok "player=$P" || no "brak playerow (mpv/vlc/ffplay/parole)"

echo "=== TEST 7: readable ==="
[ -r "$FILE" ] && ok "readable" || no "nie da sie czytac"

echo ""
echo "=== PODSUMOWANIE ==="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
