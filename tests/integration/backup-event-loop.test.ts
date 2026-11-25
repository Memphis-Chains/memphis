/**
 * THE GATE: the archive path must never freeze the runtime.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * The drill's job is to answer "is the archive restorable?". The question it
 * never got to answer was "did the runtime stay alive while it found out?".
 *
 * Measured on this host, 2026-11-25, from the runtime's own journal:
 *
 *   02:00:05  backup.scheduled.start
 *   02:06:39  backup.scheduled.success   (182 229 559 bytes)
 *             ... the restore drill starts and calls `execFileSync('tar',
 *                 ['-xzf', …])`. The event loop is BLOCKED ...
 *   02:28:53  systemd: Stopping memphis.service  (SIGTERM)
 *             ... ZERO `shutdown.*` lines from the runtime: a signal
 *                 handler cannot run while the loop is blocked ...
 *   02:29:38  systemd: State 'stop-sigterm' timed out. Killing.
 *   02:29:38  SIGKILL — "Failed with result 'timeout'"
 *
 * The drill's tar was killed by that same SIGTERM, so the drill reported
 * "Command failed: tar -xzf …" and the nightly backup was marked FAILED — a
 * failure caused by the stop, not by the archive. The runtime was SIGKILLed
 * because it could not answer a stop signal.
 *
 * The same mechanism, measured on the real 181 MB archive:
 *
 *   sync   tar 3 565 ms → heartbeat ticks during the tar: 0,
 *                      SIGTERM handler ran: never
 *   async  tar 3 565 ms → heartbeat ticks during the tar: 10,
 *                      SIGTERM handler ran: yes, delay 0 ms
 *
 * HOW THE GATE WORKS
 *
 * A `tar` shim goes first on PATH. It sleeps for a second before it does the
 * real work, and it writes a marker file before and after the sleep — so the
 * test knows EXACTLY the window in which tar was running.
 *
 * A 20 ms heartbeat runs for the whole call. If the implementation waits for
 * tar synchronously, the heartbeat cannot tick inside that window: the loop
 * is asleep. If it waits asynchronously, the heartbeat ticks all through it.
 *
 * The assertion is therefore about the loop, not about a duration: no
 * threshold to tune, no timing to be flaky about, and the gate CAN fail —
 * with the synchronous implementation it fails, and that was verified by
 * running this file against the pre-fix code.
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackup, drillBackup } from '../../src/infra/cli/commands/backup.js';
import { hashBlock } from '../../src/infra/storage/chain-adapter.js';

const roots: string[] = [];
let shimDir: string;

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), 'memphis-tar-shim-'));
  roots.push(shimDir);
  // The shim stands in for the local tar. It sleeps only for the calls that
  // do the WORK (create, extract) — not for the cheap listings, and never
  // for a long option such as `--warning=file-changed`.
  const shim = join(shimDir, 'tar');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'marker_dir="${MEMPHIS_TAR_SHIM_DIR:?}"',
      'sleep_it=0',
      'for a in "$@"; do',
      '  case "$a" in',
      '    --*) continue ;;',
      '    -*x*|*-c*) sleep_it=1 ;;',
      '  esac',
      'done',
      'if [ "$sleep_it" = "1" ]; then',
      '  : > "$marker_dir/tar-start"',
      '  sleep 1',
      '  : > "$marker_dir/tar-end"',
      'fi',
      'exec /usr/bin/tar "$@"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(shim, 0o755);
});

afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** A directory with one chain, ready to be archived. */
function sourceFixture(): { source: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'memphis-loop-source-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(join(source, 'chains', 'journal'), { recursive: true });
  const block = {
    index: 0,
    chain: 'journal',
    timestamp: '2026-01-01T00:00:00.000Z',
    prev_hash: '0'.repeat(64),
    data: { type: 'journal', content: 'retained memory' },
  };
  writeFileSync(
    join(source, 'chains', 'journal', '000000.json'),
    JSON.stringify({ ...block, hash: hashBlock(block, crypto) }),
  );
  return { source, root };
}

/** An archive of the fixture, built with the REAL tar (before the shim). */
function archiveFixture(): { archive: string } {
  const { source, root } = sourceFixture();
  const archive = join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  writeFileSync(
    `${archive}.sha256`,
    `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  fixture.tar.gz\n`,
    'utf8',
  );
  return { archive };
}

/** Put the shim first on PATH and point it at the marker directory. */
function installShim(): void {
  vi.stubEnv('PATH', `${shimDir}:${process.env.PATH ?? ''}`);
  vi.stubEnv('MEMPHIS_TAR_SHIM_DIR', shimDir);
}

/** The ticks that landed while tar was running. */
function ticksDuringTar(ticks: number[]): number[] {
  const startPath = join(shimDir, 'tar-start');
  const endPath = join(shimDir, 'tar-end');
  expect(existsSync(startPath), 'the shim never ran').toBe(true);
  expect(existsSync(endPath), 'the shim never finished').toBe(true);
  const start = statSync(startPath).mtimeMs;
  const end = statSync(endPath).mtimeMs;
  return ticks.filter((tick) => tick >= start && tick <= end);
}

describe('the archive path never freezes the runtime', () => {
  it('the drill keeps the event loop turning while it extracts the archive', async () => {
    const { archive } = archiveFixture();
    installShim();

    const ticks: number[] = [];
    const heartbeat = setInterval(() => ticks.push(Date.now()), 20);
    try {
      await drillBackup(archive);
    } finally {
      clearInterval(heartbeat);
    }

    const during = ticksDuringTar(ticks);
    // The tar slept a full second. A loop that is asleep cannot tick in it.
    expect(during.length).toBeGreaterThan(0);
  }, 60_000);

  it('creating an archive keeps the event loop turning while tar writes it', async () => {
    const { source, root } = sourceFixture();
    installShim();

    const ticks: number[] = [];
    const heartbeat = setInterval(() => ticks.push(Date.now()), 20);
    try {
      await createBackup({
        memphisRoot: source,
        backupRoot: join(root, 'backups'),
        tag: 'loop',
        showProgress: false,
      });
    } finally {
      clearInterval(heartbeat);
    }

    const during = ticksDuringTar(ticks);
    expect(during.length).toBeGreaterThan(0);
  }, 60_000);
});
