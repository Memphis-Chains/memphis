"""Discovery of the capture devices this host actually has.

The daily grabber audit used to probe `/dev/video0` unconditionally. On this
host `/dev/video0` is the v4l2loopback DUMMY device — a virtual sink that
produces frames without any camera behind it. The probe therefore read a
virtual device and reported `video: OK` while the physical grabber was
never touched, and the daily log carried a verdict about hardware that was
not involved.

The audio side had the same shape: `hw:2,0` was hardcoded, and the card at
that index is the NVIDIA HDMI device, which is playback-only. The capture
capable PCM devices are the built-in analog inputs, and the grabber's own
audio (a USB device) is absent whenever the grabber is unplugged.

These functions are pure lookups over sysfs and procfs. They take their
roots as arguments so a test can point them at a fixture tree.
"""

from __future__ import annotations

import os
from pathlib import Path

VIDEO_SYSFS = "/sys/class/video4linux"
SOUND_SYSFS = "/sys/class/sound"
ASOUND_PCM = "/proc/asound/pcm"

# The roots are overridable so a test can point the lookup at a fixture
# tree instead of the live host. The defaults are what production reads.
VIDEO_SYSFS_ENV = "MEMPHIS_GRABBER_VIDEO_SYSFS"
SOUND_SYSFS_ENV = "MEMPHIS_GRABBER_SOUND_SYSFS"
ASOUND_PCM_ENV = "MEMPHIS_GRABBER_ASOUND_PCM"


def _video_root(root=None) -> Path:
    if root is not None:
        return Path(root)
    return Path(os.environ.get(VIDEO_SYSFS_ENV) or VIDEO_SYSFS)


def _sound_root(root=None) -> Path:
    if root is not None:
        return Path(root)
    return Path(os.environ.get(SOUND_SYSFS_ENV) or SOUND_SYSFS)


def _pcm_path(path=None) -> Path:
    if path is not None:
        return Path(path)
    return Path(os.environ.get(ASOUND_PCM_ENV) or ASOUND_PCM)


def is_virtual_device(name: str) -> bool:
    """True for a device that exists without hardware behind it.

    v4l2loopback registers a node named "Dummy video device (0x0000)". It is
    a sink for other producers, so a frame read from it says nothing about
    whether a camera is connected.
    """
    lowered = name.strip().lower()
    return lowered.startswith("dummy video device") or "v4l2loopback" in lowered


def resolve_capture_device(video_root=None) -> str | None:
    """Return the `/dev/videoN` of a real capture device, or None.

    "Real" means the sysfs name is not the loopback dummy. The device nodes
    are not read: their presence in sysfs is the evidence.
    """
    root = _video_root(video_root)
    if not root.is_dir():
        return None
    for entry in sorted(root.iterdir()):
        name_file = entry / "name"
        try:
            name = name_file.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not name or is_virtual_device(name):
            continue
        return f"/dev/{entry.name}"
    return None


def resolve_usb_audio_device(sound_root=None, pcm_path=None) -> str | None:
    """Return the `hw:CARD,DEVICE` of a USB audio capture device, or None.

    A USB sound card is the one that carries the grabber's microphone; the
    built-in analog inputs are not the grabber. `/proc/asound/pcm` lists the
    PCM devices of every card, and the card index in each line matches the
    `cardN` directory in sysfs.
    """
    cards_root = _sound_root(sound_root)
    usb_cards = set()
    if cards_root.is_dir():
        for entry in cards_root.iterdir():
            if not entry.name.startswith("card") or not entry.name[4:].isdigit():
                continue
            driver_link = entry / "device" / "driver"
            try:
                driver = os.path.basename(os.readlink(driver_link))
            except OSError:
                continue
            if driver == "snd_usb_audio":
                usb_cards.add(int(entry.name[4:]))
    if not usb_cards:
        return None

    pcm_file = _pcm_path(pcm_path)
    try:
        lines = pcm_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        if "capture" not in line:
            continue
        head = line.split(":", 1)[0].strip()
        if "-" not in head:
            continue
        card_text, device_text = head.split("-", 1)
        if not card_text.isdigit() or not device_text.isdigit():
            continue
        if int(card_text) in usb_cards:
            # ALSA wants bare integers: "hw:1,0", not the zero-padded
            # "hw:01,00" that /proc/asound/pcm prints. The padded form is
            # rejected by the device open.
            return f"hw:{int(card_text)},{int(device_text)}"
    return None


def snapshot() -> dict:
    """The devices this host actually has, as a plain mapping."""
    return {
        "capture_device": resolve_capture_device(),
        "usb_audio_device": resolve_usb_audio_device(),
    }


if __name__ == "__main__":
    import json

    print(json.dumps(snapshot(), indent=2))
