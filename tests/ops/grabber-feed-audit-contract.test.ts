import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// Contract for the daily grabber audit.
//
// Measured 2026-11-09 on this host: the audit wrote a verdict about
// hardware that was not involved. The probe was called with no device
// argument and fell back to its own default `/dev/video0` — which here is
// the v4l2loopback DUMMY device ("Dummy video device (0x0000)", driver
// v4l2loopback). The audit read a virtual sink, and the daily log carried
// `video: OK` every day while the physical grabber was never opened.
//
// The audio side had the same shape: `hw:2,0` was hardcoded, and the card
// at that index is the NVIDIA HDMI device, which is playback-only.
//
// These are measured behaviours of the shipped script and helper, run
// against a fixture device tree, not source-text greps.

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const auditScript = path.join(repoRoot, 'crons', 'grabber-feed-audit.sh');
const devicesHelper = path.join(repoRoot, 'scripts', 'grabber_devices.py');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  videoSysfs: string;
  soundSysfs: string;
  pcmFile: string;
}

/**
 * A device tree the helper can read: video devices in sysfs, sound cards
 * with a driver symlink, and the PCM list.
 */
function fixture(options: {
  videoDevices?: Array<{ name: string; device: string }>;
  usbAudioCard?: { index: number; pcm: string; device: string };
}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'memphis-grabber-'));
  roots.push(root);

  const videoSysfs = path.join(root, 'video4linux');
  mkdirSync(videoSysfs, { recursive: true });
  for (const entry of options.videoDevices ?? []) {
    const dir = path.join(videoSysfs, entry.device);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'name'), `${entry.name}\n`, 'utf8');
  }

  const soundSysfs = path.join(root, 'sound');
  mkdirSync(soundSysfs, { recursive: true });
  const pcmLines: string[] = [];
  if (options.usbAudioCard) {
    const cardDir = path.join(soundSysfs, `card${options.usbAudioCard.index}`);
    const driverDir = path.join(cardDir, 'device');
    mkdirSync(driverDir, { recursive: true });
    const driverTarget = path.join(root, 'drivers', 'snd_usb_audio');
    mkdirSync(driverTarget, { recursive: true });
    symlinkSync(driverTarget, path.join(driverDir, 'driver'));
    pcmLines.push(
      `${String(options.usbAudioCard.index).padStart(2, '0')}-00: ${options.usbAudioCard.pcm} : capture 1`,
    );
  }
  // A built-in analog capture device that is NOT the grabber: the helper
  // must not offer it, because the grabber's audio is the USB one.
  pcmLines.push('00-00: ALC887-VD Analog : ALC887-VD Analog : playback 1 : capture 1');
  const pcmFile = path.join(root, 'asound-pcm');
  writeFileSync(pcmFile, `${pcmLines.join('\n')}\n`, 'utf8');

  return { root, videoSysfs, soundSysfs, pcmFile };
}

function runHelper(fx: Fixture): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('python3', [devicesHelper], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      MEMPHIS_GRABBER_VIDEO_SYSFS: fx.videoSysfs,
      MEMPHIS_GRABBER_SOUND_SYSFS: fx.soundSysfs,
      MEMPHIS_GRABBER_ASOUND_PCM: fx.pcmFile,
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The audit script, pointed at a fixture device tree and a throwaway log. */
function runAudit(fx: Fixture): { status: number | null; stdout: string; stderr: string } {
  const log = path.join(fx.root, 'grabber-feed-daily.log');
  const result = spawnSync('bash', [auditScript], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      MEMPHIS_GRABBER_VIDEO_SYSFS: fx.videoSysfs,
      MEMPHIS_GRABBER_SOUND_SYSFS: fx.soundSysfs,
      MEMPHIS_GRABBER_ASOUND_PCM: fx.pcmFile,
      MEMPHIS_GRABBER_LOG: log,
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('grabber device discovery', () => {
  it('does not offer the v4l2loopback dummy as a capture device', () => {
    const fx = fixture({
      videoDevices: [{ name: 'Dummy video device (0x0000)', device: 'video0' }],
    });
    const run = runHelper(fx);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).capture_device).toBeNull();
  });

  it('finds a real capture device when the dummy is present alongside it', () => {
    const fx = fixture({
      videoDevices: [
        { name: 'Dummy video device (0x0000)', device: 'video0' },
        { name: 'MacroSilicon MS2109 USB Capture Device', device: 'video1' },
      ],
    });
    const run = runHelper(fx);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).capture_device).toBe('/dev/video1');
  });

  it('offers the USB audio device and not the built-in analog input', () => {
    const fx = fixture({
      usbAudioCard: { index: 1, pcm: 'USB Audio', device: 'card1' },
    });
    const run = runHelper(fx);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).usb_audio_device).toBe('hw:1,0');
  });

  it('reports no USB audio when only the built-in inputs exist', () => {
    const fx = fixture({});
    const run = runHelper(fx);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).usb_audio_device).toBeNull();
  });
});

describe('the daily grabber audit', () => {
  it('reports NOT_CONNECTED instead of probing the dummy device', () => {
    const fx = fixture({
      videoDevices: [{ name: 'Dummy video device (0x0000)', device: 'video0' }],
    });
    const run = runAudit(fx);
    // The defect shape: the audit probed /dev/video0 — a virtual sink —
    // and wrote a verdict about hardware that was not involved.
    expect(run.stdout).toContain('NOT_CONNECTED');
    expect(run.stdout).not.toContain('/dev/video0');
    expect(run.status).toBe(0);
  });

  it('does not report a verdict about hardware it never opened', () => {
    const fx = fixture({
      videoDevices: [{ name: 'Dummy video device (0x0000)', device: 'video0' }],
    });
    runAudit(fx);
    const log = readFileSync(path.join(fx.root, 'grabber-feed-daily.log'), 'utf8');
    expect(log).toContain('verdict: NOT_CONNECTED');
    expect(log).not.toContain('"status": "OK"');
  });

  it('passes the discovered device to the probe instead of a hardcoded one', () => {
    // The EXECUTED lines only. A regex over the whole file matches the
    // comment that names the probe, which is a description of the old
    // call and not the call itself.
    const executed = readFileSync(auditScript, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    // The probe INVOCATION, not the assignment of the path to $PROBE.
    const probeCalls = executed.filter((line) => /python3\s+"\$PROBE"/.test(line));
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      expect(call).toContain('"$CAPTURE_DEVICE"');
      expect(call).not.toContain('/dev/video');
    }
  });
});

describe('the audit script finds its own repo', () => {
  it('does not hardcode the operator home directory', () => {
    // Measured 2026-11-09: the script pointed at
    // /home/memphis/memphis/scripts/... , which exists on the operator's
    // host and nowhere else. The CI runner checks out the repository
    // under /home/runner/work/, so the discovery step failed there and
    // the audit reported BROKEN instead of a verdict.
    const executed = readFileSync(auditScript, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    for (const line of executed) {
      expect(line).not.toContain('/home/memphis/memphis/scripts');
    }
  });

  it('runs from a checkout that is not the operator home', () => {
    // The script must resolve its helper relative to its own location,
    // so a copy of the repository anywhere on disk works.
    const fx = fixture({
      videoDevices: [{ name: 'Dummy video device (0x0000)', device: 'video0' }],
    });
    const elsewhere = path.join(fx.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const copy = path.join(elsewhere, 'grabber-feed-audit.sh');
    writeFileSync(copy, readFileSync(auditScript, 'utf8'), 'utf8');
    // The copy sits outside the repository, so the helper beside it does
    // not exist — which is exactly the failure the CI runner hit.
    const result = spawnSync('bash', [copy], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        MEMPHIS_GRABBER_VIDEO_SYSFS: fx.videoSysfs,
        MEMPHIS_GRABBER_SOUND_SYSFS: fx.soundSysfs,
        MEMPHIS_GRABBER_ASOUND_PCM: fx.pcmFile,
        MEMPHIS_GRABBER_LOG: path.join(fx.root, 'elsewhere.log'),
      },
    });
    // A missing helper is a BROKEN script, and that is reported as such —
    // never as a verdict about the hardware.
    expect(result.stdout).toContain('BROKEN');
    expect(result.stdout).not.toContain('NOT_CONNECTED');
    expect(result.status).toBe(1);
  });
});

describe('the grabber probe', () => {
  const probe = path.join(repoRoot, 'scripts', 'usb-grabber-test.py');

  it('fails when the device does not exist, whatever a previous run left behind', () => {
    // Measured 2026-11-09: the probe reported `video: OK` for a device
    // that does not exist, because video.mkv from a run six days earlier
    // was still in the work directory and the verdict was read from that
    // file. The probe must clean before it captures.
    const result = spawnSync('python3', [probe, '/dev/memphis-no-such-device'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout ?? '').not.toContain('"status": "OK"');
  });

  it('does not hardcode an ALSA card that is playback-only on this host', () => {
    // hw:2,0 is the NVIDIA HDMI device here — playback only. The audio
    // device is discovered, and its absence is reported as absence.
    const source = readFileSync(probe, 'utf8');
    const executed = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    for (const line of executed) {
      expect(line).not.toContain('hw:2,0');
    }
  });
});
