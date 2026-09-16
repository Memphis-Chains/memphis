#!/usr/bin/env bash
# scripts/install-grabber-feed-persistent.sh
# Master installer dla trwałego USB grabber feed (tier-1 + tier-2).
# Wykonuje WSZYSTKIE pozostałe kroki których nie mogę zrobić bez hasła:
#   1. Utrwala autoload v4l2loopback po rebocie
#   2. Ustawia opcje modułu (devices=2, video_nr=10,11, labels)
#   3. Dodaje memphis do grup video + audio
#   4. Instaluje opcjonalne CLI narzędzia (v4l-utils)
#
# IDEMPOTENTNY: bezpiecznie odpalić wielokrotnie. Sprawdza stan PRZED zmianą.
# DEFENSIVE: backup istniejących plików przed modyfikacją.
#
# Użycie:
#   bash scripts/install-grabber-feed-persistent.sh
# Zostanie poproszony o hasło sudo. Skrypt pokaże każdy krok PRZED wykonaniem.

set -euo pipefail

VERSION="1.0.0"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="/tmp/grabber-feed-install-backup-$TIMESTAMP"
LOG="/tmp/grabber-feed-install-$TIMESTAMP.log"

# Pliki które będę tworzył/modyfikował
MODULES_LOAD_CONF="/etc/modules-load.d/v4l2loopback.conf"
MODPROBE_D_CONF="/etc/modprobe.d/v4l2loopback.conf"
MODPROBE_D_BACKUP="${BACKUP_DIR}/modprobe.d-v4l2loopback.conf.bak"

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$LOG") 2>&1

log() {
  echo
  echo "=================================================="
  echo "[$1] $2"
  echo "=================================================="
}

confirm() {
  local prompt="$1"
  local response
  read -rp "$prompt [T/n]: " response
  case "$response" in
    n|N|nie|Nie|NIE) return 1 ;;
    *) return 0 ;;
  esac
}

require_sudo() {
  if ! sudo -n true 2>/dev/null; then
    echo "Potrzebuję sudo (wpisz hasło gdy poprosi):"
    sudo true || { echo "Sudo failed - przerwałem"; exit 1; }
  fi
}

# === BANNER ===
log "START" "USB Grabber Feed Persistent Installer v$VERSION"
echo "Timestamp: $TIMESTAMP"
echo "Backup dir: $BACKUP_DIR"
echo "Log: $LOG"
echo "Operator: $USER (uid=$(id -u))"
echo
echo "Co ten skrypt zrobi:"
echo "  1. /etc/modules-load.d/v4l2loopback.conf (1 linia: v4l2loopback)"
echo "  2. /etc/modprobe.d/v4l2loopback.conf (opcje: devices=2 video_nr=10,11)"
echo "  3. sudo usermod -aG video,audio $USER"
echo "  4. apt install -y v4l-utils (opcjonalne CLI narzędzie)"
echo "  5. newgrp video (aktywacja grup w bieżącej sesji)"
echo "  6. weryfikacja: lsmod, getfacl /dev/video10, wpctl status, memphis-grabber-test"
echo
echo "Backup PRZED każdą zmianą. Idempotentny (bezpiecznie wielokrotnie)."

# === WCZESNA WERYFIKACJA STANU ===
log "PRECHECK" "Sprawdzam aktualny stan"

if lsmod | grep -q v4l2loopback; then
  echo "v4l2loopback: ZAŁADOWANY ✓"
else
  echo "v4l2loopback: NIE ZAŁADOWANY (wymaga modprobe - skrypt tego nie robi, zrób ręcznie)"
fi

if [[ -e /dev/video10 ]]; then
  echo "/dev/video10: ISTNIEJE ✓"
else
  echo "/dev/video10: BRAK (moduł nie załadowany)"
fi

if [[ -e /dev/video0 ]]; then
  echo "/dev/video0: ISTNIEJE ✓ (grabber podłączony)"
else
  echo "/dev/video0: BRAK (grabber NIE podłączony)"
fi

if id -Gn | grep -qw video; then
  echo "Grupa video: JESTEŚ W NIEJ ✓"
else
  echo "Grupa video: NIE MA CIĘ (usermod będzie potrzebny)"
fi

if command -v v4l2-ctl >/dev/null 2>&1; then
  echo "v4l2-ctl: ZAINSTALOWANY ✓"
else
  echo "v4l2-ctl: BRAK (będzie apt install)"
fi

echo
if ! confirm "Kontynuować?"; then
  echo "Przerwane przez operatora"
  exit 0
fi

# === KROK 1: modules-load.d ===
log "STEP 1" "Tworzę $MODULES_LOAD_CONF (v4l2loopback autoload po rebocie)"

if [[ -f "$MODULES_LOAD_CONF" ]]; then
  echo "PLIK JUŻ ISTNIEJE — sprawdzam zawartość"
  if grep -qx "v4l2loopback" "$MODULES_LOAD_CONF"; then
    echo "  ✓ zawiera poprawnie 'v4l2loopback' — pomijam"
  else
    echo "  ! zawiera coś innego:"
    cat "$MODULES_LOAD_CONF" | sed 's/^/    /'
    if confirm "  Nadpisać?"; then
      sudo cp "$MODULES_LOAD_CONF" "${BACKUP_DIR}/modules-load.d-v4l2loopback.conf.bak"
      echo "v4l2loopback" | sudo tee "$MODULES_LOAD_CONF" > /dev/null
      echo "  ✓ zaktualizowano (backup: ${BACKUP_DIR}/modules-load.d-v4l2loopback.conf.bak)"
    fi
  fi
else
  require_sudo
  echo "v4l2loopback" | sudo tee "$MODULES_LOAD_CONF" > /dev/null
  echo "  ✓ utworzono: $(cat $MODULES_LOAD_CONF)"
fi

# === KROK 2: modprobe.d ===
log "STEP 2" "Tworzę $MODPROBE_D_CONF (parametry modułu: 2 kamery, video_nr=10,11)"

CONTENT="options v4l2loopback devices=2 video_nr=10,11 card_label=\"Ripper USB 0\",\"Ripper USB 1\" exclusive_caps=0,0"

if [[ -f "$MODPROBE_D_CONF" ]]; then
  echo "PLIK JUŻ ISTNIEJE — sprawdzam zawartość"
  current=$(cat "$MODPROBE_D_CONF")
  if [[ "$current" == "$CONTENT" ]]; then
    echo "  ✓ identyczny — pomijam"
  else
    echo "  ! inna zawartość:"
    echo "$current" | sed 's/^/    /'
    if confirm "  Nadpisać?"; then
      sudo cp "$MODPROBE_D_CONF" "$MODPROBE_D_BACKUP"
      echo "$CONTENT" | sudo tee "$MODPROBE_D_CONF" > /dev/null
      echo "  ✓ zaktualizowano (backup: $MODPROBE_D_BACKUP)"
    fi
  fi
else
  require_sudo
  echo "$CONTENT" | sudo tee "$MODPROBE_D_CONF" > /dev/null
  echo "  ✓ utworzono"
  cat "$MODPROBE_D_CONF" | sed 's/^/    /'
fi

# === KROK 3: usermod ===
log "STEP 3" "Dodaję $USER do grup video + audio"

groups_now=$(id -Gn)
needs_video=false
needs_audio=false
echo "$groups_now" | grep -qw video || needs_video=true
echo "$groups_now" | grep -qw audio || needs_audio=true

if ! $needs_video && ! $needs_audio; then
  echo "  ✓ już jesteś w obu grupach — pomijam"
else
  require_sudo
  to_add=""
  $needs_video && to_add+="video,"
  $needs_audio && to_add+="audio,"
  to_add="${to_add%,}"
  echo "  dodaję do: $to_add"
  sudo usermod -aG "$to_add" "$USER"
  echo "  ✓ zaktualizowano"
  echo
  echo "  UWAGA: zmiana grup wymaga przelogowania LUB użycia 'newgrp' dla bieżącej sesji"
  echo "  Alternatywa: od teraz możesz używać 'newgrp video' żeby aktywować"
fi

# === KROK 4: apt install v4l-utils (opcjonalne) ===
log "STEP 4" "apt install -y v4l-utils (opcjonalne CLI: v4l2-ctl, v4l2-compliance, qv4l2)"

if command -v v4l2-ctl >/dev/null 2>&1; then
  echo "  ✓ v4l2-ctl już jest — pomijam"
else
  if confirm "  zainstalować v4l-utils?"; then
    require_sudo
    sudo apt-get update -qq 2>&1 | tail -3
    sudo apt-get install -y v4l-utils 2>&1 | tail -5
    echo "  ✓ zainstalowano"
  else
    echo "  pominięto (v4l2-ctl nadal niedostępny — diagnostyka będzie via memphis-probe)"
  fi
fi

# === KROK 5: aktywacja grup w bieżącej sesji ===
log "STEP 5" "newgrp video (aktywacja grup BEZ przelogowania)"

echo "newgrp video uruchamia nowy shell z aktywną grupą video."
echo "UWAGA: nowy shell NADPISUJE bieżący, więc to MUSI być ostatni krok."
echo
if confirm "  uruchomić newgrp video? (potem będziesz musiał odpalić następne komendy w nowym shellu)"; then
  exec newgrp video
else
  echo "  pominięto (przeloguj się ręcznie żeby grupy były aktywne)"
fi

# === KROK 6: weryfikacja ===
log "STEP 6" "Weryfikacja końcowa"

echo "Grupy: $(id -Gn | tr ' ' ',')"
echo

if lsmod | grep -q v4l2loopback; then
  echo "✓ v4l2loopback załadowany"
else
  echo "✗ v4l2loopback NIE załadowany — odpal: sudo modprobe v4l2loopback devices=2 video_nr=10,11 card_label='Ripper USB 0','Ripper USB 1' exclusive_caps=0,0"
fi

if [[ -e /dev/video10 ]]; then
  echo "✓ /dev/video10 istnieje"
  getfacl -p /dev/video10 2>&1 | head -5 | sed 's/^/  /'
else
  echo "✗ /dev/video10 nie istnieje (moduł zły video_nr)"
fi

echo
if command -v v4l2-ctl >/dev/null 2>&1; then
  echo "✓ v4l2-ctl: $(v4l2-ctl --version 2>&1 | head -1)"
fi

echo
echo "Autostart configs:"
ls -la /etc/modules-load.d/v4l2loopback.conf /etc/modprobe.d/v4l2loopback.conf 2>&1 | sed 's/^/  /'

echo
echo "systemd user services aktywne:"
systemctl --user list-units --type=service --state=active 2>&1 | grep memphis | sed 's/^/  /'

echo
log "DONE" "Skrypt zakończony"
echo "Log: $LOG"
echo "Backup (jeśli był): $BACKUP_DIR"
echo
echo "NASTĘPNE KROKI:"
echo "  1. Sprawdź Telegram: Settings → Devices → Camera → 'Ripper USB 0'"
echo "  2. Test: memphis-grabber-test"
echo "  3. Reboot test: systemctl reboot (potem: systemctl --user status memphis-grabber-feed.service)"
