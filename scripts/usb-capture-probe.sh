#!/usr/bin/env bash
# scripts/usb-capture-probe.sh
# Tier-0 autonomous probe: wykrywa USB capture devices (V4L2 + audio + storage)
# bez instalacji czegokolwiek. Generuje raport JSON na stdout + zapisuje do
# ~/.memphis/logs/usb-capture-probe-<timestamp>.json oraz .raw sidecar.
#
# Użycie: bash scripts/usb-capture-probe.sh [--watch]
#   --watch: nie wychodzi, pętla co 5s (Ctrl+C aby wyjść)

set -u

LOGDIR="${MEMPHIS_LOGDIR:-$HOME/.memphis/logs}"
mkdir -p "$LOGDIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="$LOGDIR/usb-capture-probe-$TS.json"
RAW="$REPORT.raw"

WATCH=0
[[ "${1:-}" == "--watch" ]] && WATCH=1

probe_once() {
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # 1. Video devices
  local video_count=0
  if compgen -G "/dev/video*" > /dev/null; then
    video_count=$(ls /dev/video* 2>/dev/null | wc -l)
  fi

  # 2. ffmpeg V4L2 sources
  local v4l2_count=0
  if [[ $video_count -gt 0 ]]; then
    v4l2_count=$(ffmpeg -hide_banner -sources v4l2 2>&1 | grep -c "/dev/video" || true)
  fi

  # 3. NVIDIA NVENC
  local nvenc_status="absent"
  if command -v nvidia-smi >/dev/null 2>&1; then
    local driver
    driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | tr -d '\n')
    if [[ -n "$driver" ]]; then
      nvenc_status="present driver=$driver"
    fi
  fi

  # 4. OBS plugins
  local obs_plugins=""
  if [[ -d /usr/lib/x86_64-linux-gnu/obs-plugins ]]; then
    obs_plugins=$(ls /usr/lib/x86_64-linux-gnu/obs-plugins/*.so 2>/dev/null \
      | xargs -n1 basename | paste -sd, -)
  fi

  # JSON-LD output
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

dump_raw() {
  {
    echo "=== lsusb ==="; lsusb 2>&1
    echo "=== /dev/video* ==="; ls /dev/video* 2>&1 || true
    echo "=== arecord -l ==="; arecord -l 2>&1
    echo "=== lsblk (usb) ==="; lsblk -o NAME,SIZE,TRAN,MOUNTPOINT,VENDOR,MODEL 2>&1 | grep -i usb || true
  } > "$RAW"
}

# Główna logika (single-source-of-truth)
probe_once | tee "$REPORT" >/dev/null
dump_raw

if [[ $WATCH -eq 1 ]]; then
  echo "WATCH MODE: Ctrl+C aby wyjść. Raporty: $LOGDIR/usb-capture-probe-*.json"
  trap 'echo "Exited."; exit 0' INT TERM
  while true; do
    cat "$REPORT"
    echo "---"
    sleep 5
    # Re-probe
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    REPORT="$LOGDIR/usb-capture-probe-$TS.json"
    RAW="$REPORT.raw"
    probe_once | tee "$REPORT" >/dev/null
    dump_raw
  done
else
  cat "$REPORT"
  echo
  echo "Saved: $REPORT (+ .raw sidecar)" >&2
fi
