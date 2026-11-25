import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reapDeadDrillScratch } from '../../src/infra/cli/commands/backup.js';

/**
 * The rule that buries the scratch of a drill that was killed.
 *
 * WHY the rule exists: a drill's scratch is ~489 MB and 13 002 files, and
 * the drill removes it in a `finally` — which does not run when the process
 * is killed. MEASURED on this host, 2026-11-25: the live stop-during-drill
 * test left `memphis-verified-drill-Jsb39N` behind with 489 MB and 13 002
 * files, and nothing in the runtime ever collected it.
 *
 * The rule may only bury a scratch it can PROVE is a corpse, and it has two
 * proofs: the owner named in the scratch's name, and — for the scratch of a
 * drill that ran before the name carried the owner — the directory's ctime,
 * which tar cannot forge.
 */
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'backup-drill-scratch-'));
  roots.push(root);
  return root;
}

describe('the rule that buries an abandoned drill scratch', () => {
  it('removes a scratch whose owner the kernel says is gone', () => {
    const root = scratchRoot();
    const corpse = join(root, 'memphis-verified-drill-999999999-Jsb39N');
    mkdirSync(corpse);
    writeFileSync(join(corpse, 'left-behind.txt'), 'the corpse of a killed drill');
    expect(reapDeadDrillScratch(root)).toEqual(['memphis-verified-drill-999999999-Jsb39N']);
    expect(existsSync(corpse)).toBe(false);
  });

  it('leaves a scratch whose owner is alive', () => {
    const root = scratchRoot();
    // PID 1 exists on every Linux host, and it is not ours.
    const live = join(root, 'memphis-verified-drill-1-Jsb39N');
    mkdirSync(live);
    expect(reapDeadDrillScratch(root)).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it('leaves its own scratch alone', () => {
    const root = scratchRoot();
    const own = join(root, `memphis-verified-drill-${process.pid}-Jsb39N`);
    mkdirSync(own);
    expect(reapDeadDrillScratch(root)).toEqual([]);
    expect(existsSync(own)).toBe(true);
  });

  it('removes the scratch of the shape the drill used before the owner was in the name', () => {
    const root = scratchRoot();
    // The shape of the MEASURED 489 MB corpse: a bare `mkdtemp` suffix, with
    // no owner in the name. Nothing can be asked about its owner, so the
    // directory's own ctime is the proof: the ctime is the last time an entry
    // was created inside it — the extraction — and tar cannot forge it.
    const corpse = join(root, 'memphis-verified-drill-Jsb39N');
    mkdirSync(corpse);
    writeFileSync(join(corpse, 'left-behind.txt'), 'the corpse of a killed drill');
    // The threshold is a parameter so the gate does not have to wait six
    // hours to hold the rule to a fixed answer.
    expect(reapDeadDrillScratch(root, 0)).toEqual(['memphis-verified-drill-Jsb39N']);
    expect(existsSync(corpse)).toBe(false);
  });

  it('keeps a scratch without an owner that could still be in flight', () => {
    const root = scratchRoot();
    const maybeLive = join(root, 'memphis-verified-drill-Jsb39N');
    mkdirSync(maybeLive);
    // Fresh: the default threshold is six hours, ~16× the longest drill
    // measured on this host (22 m 16 s), so a fresh scratch may still belong
    // to a drill that is running.
    expect(reapDeadDrillScratch(root)).toEqual([]);
    expect(existsSync(maybeLive)).toBe(true);
  });

  it('does not read a legacy suffix that starts with digits as an owner', () => {
    const root = scratchRoot();
    // A legacy `mkdtemp` suffix can start with digits. Reading "3" as a pid
    // would name a process that never owned the scratch — and PID 3 is alive
    // on this host, so the scratch would be kept for the wrong reason.
    const legacy = join(root, 'memphis-verified-drill-3sb39N');
    mkdirSync(legacy);
    expect(reapDeadDrillScratch(root, 0)).toEqual(['memphis-verified-drill-3sb39N']);
    expect(existsSync(legacy)).toBe(false);
  });

  it('ignores directories that are not drill scratches', () => {
    const root = scratchRoot();
    const other = join(root, 'memphis-verified-drill');
    mkdirSync(other);
    const archive = join(root, 'scheduled-2026-11-25-02-00.tar.gz');
    writeFileSync(archive, 'not a scratch');
    expect(reapDeadDrillScratch(root, 0)).toEqual([]);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(archive)).toBe(true);
  });
});
