import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OFFSITE_STATE_FILENAME,
  readOffsiteBackupState,
} from '../../src/infra/cli/commands/offsite-backup-state.js';

const roots: string[] = [];

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-offsite-state-'));
  roots.push(root);
  return root;
}

function writeState(dir: string, content: string): void {
  writeFileSync(join(dir, OFFSITE_STATE_FILENAME), content, 'utf8');
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readOffsiteBackupState', () => {
  it('reports a never-run copy as unknown and stale', () => {
    // No state file means the copy step has never run here, which is a
    // different fact from "it ran and failed" — and both are worth seeing.
    const state = readOffsiteBackupState(makeDataDir());
    expect(state.status).toBe('unknown');
    expect(state.updatedAt).toBeNull();
    expect(state.ageMs).toBeNull();
    expect(state.isStale).toBe(true);
  });

  it('reports a successful copy with its age and archive', () => {
    const dir = makeDataDir();
    const now = Date.parse('2026-10-23T12:00:00Z');
    writeState(
      dir,
      JSON.stringify({
        status: 'ok',
        detail: 'scheduled-2026-10-23.tar.gz',
        updatedAt: '2026-10-23T11:30:00Z',
        mount: '/run/media/memphis/memphis-usb-back',
        archive: 'scheduled-2026-10-23.tar.gz',
      }),
    );
    const state = readOffsiteBackupState(dir, now);
    expect(state.status).toBe('ok');
    expect(state.ageMs).toBe(30 * 60 * 1000);
    expect(state.archive).toBe('scheduled-2026-10-23.tar.gz');
    expect(state.isStale).toBe(false);
  });

  it('marks a missing drive as stale, with the reason it gives', () => {
    // This is the case that was invisible: the drive is unplugged and every
    // run says so in the journal, but nothing said so in `health`.
    const dir = makeDataDir();
    writeState(
      dir,
      JSON.stringify({
        status: 'no-usb',
        detail: 'no mountpoint found',
        updatedAt: '2026-10-23T11:30:00Z',
        mount: '',
        archive: '',
      }),
    );
    const state = readOffsiteBackupState(dir, Date.parse('2026-10-23T12:00:00Z'));
    expect(state.status).toBe('no-usb');
    expect(state.isStale).toBe(true);
    expect(state.detail).toContain('no mountpoint');
  });

  it('marks a successful copy as stale once it is older than the timer interval', () => {
    // The timer runs every four hours. A copy older than that means the step
    // has not run since, even though the last run succeeded.
    const dir = makeDataDir();
    writeState(
      dir,
      JSON.stringify({
        status: 'ok',
        updatedAt: '2026-10-23T06:00:00Z',
        mount: '/run/media/memphis/memphis-usb-back',
        archive: 'scheduled.tar.gz',
      }),
    );
    const state = readOffsiteBackupState(dir, Date.parse('2026-10-23T12:00:00Z'));
    expect(state.status).toBe('ok');
    expect(state.isStale).toBe(true);
  });

  it('survives an unreadable state file', () => {
    const dir = makeDataDir();
    writeState(dir, '{ this is not json');
    const state = readOffsiteBackupState(dir);
    expect(state.status).toBe('unknown');
    expect(state.isStale).toBe(true);
    expect(state.detail).toContain('unreadable');
  });

  it('does not trust an unknown status value', () => {
    const dir = makeDataDir();
    writeState(dir, JSON.stringify({ status: 'definitely-not-a-status', updatedAt: 'x' }));
    const state = readOffsiteBackupState(dir);
    expect(state.status).toBe('unknown');
    expect(state.isStale).toBe(true);
  });

  it('does not let a malformed timestamp produce a negative or NaN age', () => {
    const dir = makeDataDir();
    writeState(dir, JSON.stringify({ status: 'ok', updatedAt: 'not-a-date', archive: 'x.tar.gz' }));
    const state = readOffsiteBackupState(dir, Date.now());
    expect(state.ageMs).toBeNull();
    expect(state.isStale).toBe(true);
  });
});

describe('scripts/backup-to-usb.sh — leaves a state file behind', () => {
  it('writes the state on every exit path, including the failures', () => {
    // The copy step runs from a timer, so nothing about it survives in the
    // daemon's memory. It writes this file instead, and the health payload
    // reads it — otherwise a copy that silently stops is exactly what goes
    // unnoticed. Asserted on the source because the exit paths are the
    // contract, and each one has to record what it was.
    const source = readFileSync('scripts/backup-to-usb.sh', 'utf8');
    // Counted per status rather than in total: my first version asserted a
    // total count, and removing one `write_state` from one branch still left
    // the total above the threshold — so the test passed on a script that had
    // lost exactly the write that makes a missing drive visible.
    const expected: Record<string, number> = {
      ok: 1,
      'up-to-date': 1,
      'no-usb': 3,
      'no-archive': 2,
      'verify-failed': 1,
      'copy-failed': 2,
    };
    for (const [status, count] of Object.entries(expected)) {
      const actual = (source.match(new RegExp(`write_state "${status}"`, 'g')) ?? []).length;
      expect(actual, `write_state "${status}" must appear ${count} time(s)`).toBe(count);
    }
  });

  it('writes the state atomically, so a reader never sees half a file', () => {
    const source = readFileSync('scripts/backup-to-usb.sh', 'utf8');
    expect(source).toMatch(/mktemp/);
    expect(source).toMatch(/mv -f "\$tmp" "\$STATE_FILE"/);
  });
});
