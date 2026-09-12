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
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # 1. USB devices
  local usb_devices
  usb_devices=$(lsusb 2>/dev/null | head -50)

  # 2. Video devices
  local video_devs=()
  if compgen -G "/dev/video*" > /dev/null; then
    for f in /dev/video*; do video_devs+=("$f"); done
  fi
  local video_count=${#video_devs[@]}

  # 3. Audio capture devices (ALSA)
  local alsa_cards
  alsa_cards=$(arecord -l 2>/dev/null | grep -E "^card" | awk '{print $0}')

  # 4. Block storage (USB)
  local usb_storage
  usb_storage=$(lsblk -J -o NAME,SIZE,TYPE,TRAN,MOUNTPOINT,VENDOR,MODEL 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps([x for x in d['blockdevices'] if x.get('tran')=='usb'], indent=2))" 2>/dev/null || echo "[]")

  # 5. ffmpeg V4L2 sources (jeśli są video_devs)
  local v4l2_count=0
  if [[ $video_count -gt 0 ]]; then
    v4l2_count=$(ffmpeg -hide_banner -sources v4l2 2>&1 | grep -c "/dev/video" || true)
  fi

  # 6. NVIDIA NVENC capability (tylko driver — cuda_version jest invalid field)
  local nvenc_status="absent"
  if command -v nvidia-smi >/dev/null 2>&1; then
    local driver
    driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | tr -d '\n')
    if [[ -n "$driver" ]]; then
      nvenc_status="present driver=$driver"
    fi
  fi

  # 7. OBS plugins
  local obs_plugins=""
  if [[ -d /usr/lib/x86_64-linux-gnu/obs-plugins ]]; then
    obs_plugins=$(ls /usr/lib/x86_64-linux-gnu/obs-plugins/*.so 2>/dev/null \
      | xargs -n1 basename | paste -sd, -)
  fi

  # JSON-LD output (escape strings via python json)
  python3 - "$now" "$video_count" "$v4l2_count" "$nvenc_status" "$obs_plugins" <<'PY'
import json, sys
now, vc, v4lc, nvenc, plugins = sys.argv[1:6]
data = {
  "timestamp": now,
  "video_devices_count": int(vc),
  "v4l2_ffmpeg_sources": int(v4lc),
  "nvenc_status": nvenc,
  "obs_plugins": plugins,
}
print(json.dumps(data, indent=2))
PY
}

if [[ $WATCH -eq 1 ]]; then
  echo "WATCH MODE: Ctrl+C aby wyjść. Raporty: $LOGDIR/usb-capture-probe-*.json"
  trap 'echo "Exited."; exit 0' INT TERM
  while true; do probe_once | tee "$REPORT"; echo "---"; sleep 5; done
else
  probe_once | tee "$REPORT" >/dev/null
  cat "$REPORT"
  echo
  echo "Saved: $REPORT" >&2
fi
if [[ $WATCH -eq 1 ]]; then
  echo "WATCH MODE: Ctrl+C aby wyjść. Raporty: $LOGDIR/usb-capture-probe-*.json"
  trap 'echo "Exited."; exit 0' INT TERM
  while true; do probe_once | tee "$REPORT" >/dev/null
    # raw diagnostic dump (separately, easier to grep)
    {
      echo "=== lsusb ==="; lsusb
      echo "=== /dev/video* ==="; ls /dev/video* 2>&1 || true
      echo "=== arecord -l ==="; arecord -l
      echo "=== lsblk (usb) ==="; lsblk -o NAME,SIZE,TRAN,MOUNTPOINT,VENDOR,MODEL | grep -i usb || true
    } > "$REPORT.raw"
    cat "$REPORT"; echo "---"; sleep 5; done
else
  probe_once | tee "$REPORT" >/dev/null
  # raw diagnostic dump to .raw sidecar
  {
    echo "=== lsusb ==="; lsusb
    echo "=== /dev/video* ==="; ls /dev/video* 2>&1 || true
    echo "=== arecord -l ==="; arecord -l
    echo "=== lsblk (usb) ==="; lsblk -o NAME,SIZE,TRAN,MOUNTPOINT,VENDOR,MODEL | grep -i usb || true
  } > "$REPORT.raw"
  cat "$REPORT"
  echo
  echo "Saved: $REPORT (+ .raw sidecar)" >&2
fi