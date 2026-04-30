import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';

describe('doctor --fix --apply orphan cleanup (S4-1)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('reports orphans as dry-run when --fix without --apply', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-fix-'));
    // Plant an orphan file.
    writeFileSync(join(memphisDir, 'stale-debug.log'), 'noise\n');

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2({ fix: true });
    const dryRunRepair = report.repairs.find((r) =>
      typeof r === 'string' ? r.includes('dry-run') : false,
    );
    expect(dryRunRepair).toBeDefined();
    expect(dryRunRepair).toContain('stale-debug.log');
    // Orphan must still be present — dry-run does not delete.
    expect(existsSync(join(memphisDir, 'stale-debug.log'))).toBe(true);
  });

  it('does not move active runtime dirs (telemetry/state/intelligence/skills/chain-snapshots) — Codex P1 round 1', async () => {
    // Operator regression: Wodzu's smoke listed `telemetry` and `state`
    // as orphans. These are active runtime dirs (telemetry from the
    // observability exporters; state from self-modify-revert).
    // --fix --apply must leave them untouched.
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-fix-'));
    mkdirSync(join(memphisDir, 'backups'), { recursive: true });
    for (const active of [
      'telemetry',
      'state',
      'intelligence',
      'skills',
      'chain-snapshots',
      'social',
    ]) {
      mkdirSync(join(memphisDir, active), { recursive: true });
      writeFileSync(join(memphisDir, active, 'sentinel'), 'live\n');
    }
    // Plant one true orphan to confirm the move path still runs.
    writeFileSync(join(memphisDir, 'totally-stale.log'), 'noise\n');

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    await runDoctorChecksV2({ fix: true, apply: true });

    // Active dirs survive in place.
    for (const active of [
      'telemetry',
      'state',
      'intelligence',
      'skills',
      'chain-snapshots',
      'social',
    ]) {
      expect(existsSync(join(memphisDir, active, 'sentinel'))).toBe(true);
    }
    // True orphan was moved.
    expect(existsSync(join(memphisDir, 'totally-stale.log'))).toBe(false);
  });

  it('moves orphans into ~/.memphis/backup/orphans-<ts>/ when --fix --apply', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-fix-'));
    mkdirSync(join(memphisDir, 'backups'), { recursive: true });
    writeFileSync(join(memphisDir, 'stale-debug.log'), 'noise\n');
    writeFileSync(join(memphisDir, 'old-thing'), 'x');

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2({ fix: true, apply: true });
    // Originals removed from data dir.
    expect(existsSync(join(memphisDir, 'stale-debug.log'))).toBe(false);
    expect(existsSync(join(memphisDir, 'old-thing'))).toBe(false);

    // Backup folder created with both files preserved.
    const backupRoot = join(memphisDir, 'backups');
    const orphanDirs = readdirSync(backupRoot).filter((n) => n.startsWith('orphans-'));
    expect(orphanDirs.length).toBe(1);
    const movedDir = join(backupRoot, orphanDirs[0]);
    expect(existsSync(join(movedDir, 'stale-debug.log'))).toBe(true);
    expect(existsSync(join(movedDir, 'old-thing'))).toBe(true);

    // Repair log mentions the move.
    const moveAction = report.repairs.find((r) =>
      typeof r === 'string' ? r.includes('moved orphan') : false,
    );
    expect(moveAction).toBeDefined();
  });
});
