#!/usr/bin/env python3
# scripts/usb-grabber-test.py
# Tier-0 helper: defensive test grabbera USB (video + audio entropy)
# Użycie: python3 scripts/usb-grabber-test.py [device] [duration_sec]
# Exit 0 = wszystko OK, exit 1 = video failure, exit 2 = audio failure,
# exit 3 = urzadzenie obecne, ale nie nadaje sygnalu
#
# Measured 2026-11-09: the device argument defaulted to /dev/video0, which
# on this host is the v4l2loopback DUMMY device. The probe read a virtual
# sink and reported "video: OK" for hardware that was not involved. The
# caller now discovers the device (scripts/grabber_devices.py) and passes
# it; the default is kept only so a bare invocation still names a device
# rather than silently probing nothing.

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
# ALSA capture device, e.g. "hw:1,0". Discovered by the caller when the
# grabber is attached; empty means there is no USB audio on this host.
AUDIO_DEVICE = sys.argv[3] if len(sys.argv) > 3 else ""
TMP = Path("/tmp/grabber-test")
TMP.mkdir(exist_ok=True)

# The probe reads the file ffmpeg produced and judges the verdict from it.
# A file left behind by an earlier run would be judged as if it were this
# run's capture, so the stale artefacts are removed first.
#
# Measured 2026-11-09: with a device that does not exist, the probe
# reported `video: OK` because video.mkv from a run six days earlier was
# still in place. The verdict was about a capture that never happened.
for _stale in TMP.glob("*"):
    try:
        _stale.unlink()
    except OSError:
        pass

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

    verdict = "DYNAMIC" if unique == len(frame_hashes) else \
              "PARTIAL" if unique > 1 else "STATIC_OR_NO_SIGNAL"
    results["video"] = {
        "file": str(video_file),
        "size_bytes": video_file.stat().st_size,
        "frames_recorded": len(frame_hashes),
        "unique_frames": unique,
        "status": "OK" if verdict != "STATIC_OR_NO_SIGNAL" else "NO_SIGNAL",
        "verdict": verdict
    }
    video_ok = True
    # A device that produces one repeated frame is present but not showing
    # anything. Reporting that as "OK" is the same kind of green that the
    # whole audit was wrong about: the file was written, so the status said
    # OK, while no signal ever arrived.
    video_no_signal = verdict == "STATIC_OR_NO_SIGNAL"
else:
    results["video"] = {"status": "FAIL", "error": r.stderr.strip()[:200]}
    video_ok = False
    video_no_signal = False

# === AUDIO TEST ===
if not AUDIO_DEVICE:
    # No USB capture device on this host. That is a fact about the machine,
    # not a failure of the grabber, and it is not the same thing as audio
    # hardware that is present but silent.
    print("\n=== AUDIO test: skipped (no USB audio device on this host) ===")
    results["audio"] = {"status": "NOT_PRESENT", "reason": "no USB capture device"}
    audio_ok = True
else:
    print(f"\n=== AUDIO test: ALSA {AUDIO_DEVICE} {DURATION}s ===")
    audio_file = TMP / "audio.wav"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
        "-f", "alsa", "-channels", "2", "-sample_rate", "48000", "-i", AUDIO_DEVICE,
        "-t", str(DURATION), "-c:a", "pcm_s16le", str(audio_file)
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stderr.strip())

if AUDIO_DEVICE and audio_file.exists() and audio_file.stat().st_size > 100:
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
elif AUDIO_DEVICE:
    results["audio"] = {"status": "FAIL", "error": r.stderr.strip()[:200]}
    audio_ok = False

# === SUMMARY ===
print(f"\n=== SUMMARY ===")
print(json.dumps(results, indent=2))

# 0 = both fine, 1 = video failed, 2 = audio failed, 3 = device present but
# no signal. The three failure kinds are distinct facts and the caller
# reports them differently.
if not video_ok:
    sys.exit(1)
if not audio_ok:
    sys.exit(2)
if video_no_signal:
    sys.exit(3)
sys.exit(0)
