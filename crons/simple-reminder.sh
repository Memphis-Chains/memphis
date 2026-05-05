#!/bin/bash
# Simple reminder script — Memphis self-coding attempt
# Model: cogito:3b (via Ollama)
# Generated: 2026-05-04

set -e

REMINDER_FILE="${MEMPHIS_DATA:-~/.memphis}/data/reminders.txt"
mkdir -p "$(dirname "$REMINDER_FILE")"

case "$1" in
  add)
    shift
    echo "[$(date '+%Y-%m-%d %H:%M')] $*" >> "$REMINDER_FILE"
    echo "✓ Dodano: $*"
    ;;
  list)
    if [ -f "$REMINDER_FILE" ] && [ -s "$REMINDER_FILE" ]; then
      echo "=== Twoje przypomnienia ==="
      cat "$REMINDER_FILE"
    else
      echo "Brak przypomnień."
    fi
    ;;
  clear)
    > "$REMINDER_FILE"
    echo "✓ Wyczyszczono."
    ;;
  *)
    echo "Użycie: $0 {add|list|clear} [tekst]"
    echo "  add [tekst]   — dodaj przypomnienie"
    echo "  list          — pokaż wszystkie"
    echo "  clear         — wyczyść wszystkie"
    ;;
esac