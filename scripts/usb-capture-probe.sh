#!/usr/bin/env bash
# scripts/usb-capture-probe.sh
# Tier-0 autonomous probe: wykrywa USB capture devices (V4L2 + audio + storage)
# bez instalacji czegokolwiek. Generuje raport JSON na stdout + zapisuje do
# ~/.memphis/logs/usb-capture-probe-<timestamp>.json dla późniejszego audytu.
#
# Użycie: bash scripts/usb-capture-probe.sh [--watch]
#   --watch: nie wychodzi, pętla co 5s (Ctrl+C aby wyjść)

set -u

LOGDIR="${MEMPHIS_LOGDIR:-$HOME/.memphis/logs}"
mkdir -p "$LOGDIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="$LOGDIR/usb-capture-probe-$TS.json"

WATCH=0
[[ "${1:-}" == "--watch" ]] && WATCH=1

probe_once() {
  local ts now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # 1. USB devices (vendor:product + klasa)
  local usb_devices
  usb_devices=$(lsusb 2>/dev/null | awk '{print $0}' | head -50)

  # 2. Video devices
  local video_devs=()
  if compgen -G "/dev/video*" > /dev/null; then
    for f in /dev/video*; do video_devs+=("$f"); done
  fi
  local video_count=${#video_devs[@]}

  # 3. Audio capture devices (ALSA)
  local alsa_cards
  alsa_cards=$(arecord -l 2>/dev/null | grep -E "^card" | awk '{print $0}')

  # 4. Block storage (USB mountpointy)
  local usb_storage
  usb_storage=$(lsblk -J -o NAME,SIZE,TYPE,TRAN,MOUNTPOINT,VENDOR,MODEL 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps([x for x in d['blockdevices'] if x.get('tran')=='usb'], indent=2))" 2>/dev/null)

  # 5. ffmpeg V4L2 sources (jeśli video_devs istnieją)
  local v4l2_sources=""
  if [[ $video_count -gt 0 ]]; then
    v4l2_sources=$(ffmpeg -hide_banner -sources v4l2 2>&1 | head -20)
  fi

  # 6. NVIDIA NVENC capability
  local nvenc_status="absent"
  if command -v nvidia-smi >/dev/null 2>&1; then
    local driver cuda
    driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
    cuda=$(nvidia-smi --query-gpu=cuda_version --format=csv,noheader 2>/dev/null | head -1)
    nvenc_status="present driver=$driver cuda=$cuda"
  fi

  # 7. OBS plugins dostępne
  local obs_plugins=""
  if [[ -d /usr/lib/x86_64-linux-gnu/obs-plugins ]]; then
    obs_plugins=$(ls /usr/lib/x86_64-linux-gnu/obs-plugins/*.so 2>/dev/null \
      | xargs -n1 basename | paste -sd, -)
  fi

  cat > "$REPORT" <<JSON
{
  "timestamp": "$now",
  "video_devices_count": $video_count,
  "video_devices": $(printf '%s\n' "${video_devs[@]:-}" | python3 -c "import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))"),
  "alsa_capture": $(printf '%s' "$alsa_cards" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().splitlines()))"),
  "usb_storage": $(printf '%s' "${usb_storage:-[]}" | python3 -c "import json,sys; d=sys.stdin.read().strip() or '[]'; print(d if d.startswith('[') else '[]')"),
  "nvenc_status": "$nvenc_status",
  "obs_plugins": "$obs_plugins",
  "usb_bus_summary": $(printf '%s\n' "$usb_devices" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().splitlines()))")
}
JSON

  cat "$REPORT"
}

if [[ $WATCH -eq 1 ]]; then
  echo "WATCH MODE: Ctrl+C aby wyjść. Raporty: $LOGDIR/usb-capture-probe-*.json"
  trap 'echo "Exited. Last report: $REPORT"; exit 0' INT TERM
  while true; do probe_once; echo "---"; sleep 5; done
else
  probe_once
  echo
  echo "Saved: $REPORT" >&2
fi
