#!/usr/bin/env python3
# scripts/usb-grabber-test.py
# Tier-0 helper: defensive test grabbera USB (video + audio entropy)
# Użycie: python3 scripts/usb-grabber-test.py [device] [duration_sec]
# Exit 0 = wszystko OK, exit 1 = video failure, exit 2 = audio failure

import subprocess
import sys
import os
import wave
import struct
import math
import hashlib
import json
from pathlib import Path

DEVICE = sys.argv[1] if len(sys.argv) > 1 else "/dev/video0"
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 3
TMP = Path("/tmp/grabber-test")
TMP.mkdir(exist_ok=True)

results = {}

# === VIDEO TEST ===
print(f"=== VIDEO test: {DEVICE} {DURATION}s 1280x720 mjpeg ===")
video_file = TMP / "video.mkv"
cmd = [
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
    "-f", "v4l2", "-framerate", "30", "-video_size", "1280x720",
    "-input_format", "mjpeg", "-i", DEVICE,
    "-t", str(DURATION), "-c:v", "copy", str(video_file)
]
r = subprocess.run(cmd, capture_output=True, text=True)
print(r.stderr.strip())

if video_file.exists() and video_file.stat().st_size > 1000:
    # Sprawdź klatki
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames,duration",
        str(video_file)
    ], capture_output=True, text=True)
    print(probe.stdout.strip())

    # Wyciągnij 5 klatek i porównaj hashe
    frame_hashes = []
    for i, fnum in enumerate([0, 22, 44, 66, 86]):
        out = TMP / f"f{i}.jpg"
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(video_file), "-vf", f"select=eq(n\\,{fnum})",
            "-vframes", "1", str(out)
        ])
        if out.exists():
            h = hashlib.sha256(out.read_bytes()).hexdigest()[:16]
            frame_hashes.append(h)
            print(f"  Klatka {fnum}: {out.stat().st_size}B {h}")

    unique = len(set(frame_hashes))
    print(f"  Unikalne: {unique}/{len(frame_hashes)}")

    results["video"] = {
        "file": str(video_file),
        "size_bytes": video_file.stat().st_size,
        "frames_recorded": len(frame_hashes),
        "unique_frames": unique,
        "status": "OK",
        "verdict": "DYNAMIC" if unique == len(frame_hashes) else
                  "PARTIAL" if unique > 1 else "STATIC_OR_NO_SIGNAL"
    }
    video_ok = True
else:
    results["video"] = {"status": "FAIL", "error": r.stderr.strip()[:200]}
    video_ok = False

# === AUDIO TEST ===
print(f"\n=== AUDIO test: ALSA hw:2,0 {DURATION}s ===")
audio_file = TMP / "audio.wav"
cmd = [
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
    "-f", "alsa", "-channels", "2", "-sample_rate", "48000", "-i", "hw:2,0",
    "-t", str(DURATION), "-c:a", "pcm_s16le", str(audio_file)
]
r = subprocess.run(cmd, capture_output=True, text=True)
print(r.stderr.strip())

if audio_file.exists() and audio_file.stat().st_size > 100:
    with wave.open(str(audio_file), "rb") as w:
        n = w.getnframes()
        rate = w.getframerate()
        raw = w.readframes(n)
        samples = struct.unpack(f"<{n*2}h", raw)
        rms = math.sqrt(sum(s*s for s in samples) / len(samples))
        peak = max(abs(s) for s in samples) if samples else 0
        dbfs = 20 * math.log10(rms/32768) if rms > 0 else -100

    print(f"  RMS={rms:.0f} ({dbfs:.1f} dBFS) Peak={peak}")
    if rms < 50:
        verdict = "SILENT"
    elif rms < 500:
        verdict = "NOISE_ONLY"
    elif rms < 5000:
        verdict = "QUIET_SIGNAL"
    else:
        verdict = "ACTIVE_SIGNAL"

    results["audio"] = {
        "file": str(audio_file),
        "size_bytes": audio_file.stat().st_size,
        "rms": rms,
        "peak": peak,
        "dbfs": round(dbfs, 1),
        "status": "OK",
        "verdict": verdict
    }
    audio_ok = True
else:
    results["audio"] = {"status": "FAIL", "error": r.stderr.strip()[:200]}
    audio_ok = False

# === SUMMARY ===
print(f"\n=== SUMMARY ===")
print(json.dumps(results, indent=2))

sys.exit(0 if (video_ok and audio_ok) else (1 if not video_ok else 2))
