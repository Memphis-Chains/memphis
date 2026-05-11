/**
 * Tier-3 session persistence — load/save/expire/feature-gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPersistedSessions,
  getPersistencePath,
  loadPersistedSessions,
  persistSessions,
} from '../../src/security/tier3-session-persistence.js';
import type { Tier3Session } from '../../src/security/tier3-session.js';

describe('tier3-session-persistence', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier3-persist-test-'));
    env = { ...process.env, MEMPHIS_HOME: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const session = (overrides: Partial<Tier3Session> = {}): Tier3Session => ({
    surface: 'tui',
    actorId: 'local',
    tier: 3,
    grantedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });

  it('roundtrips a single session via disk', () => {
    const s = session();
    const map = new Map<string, Tier3Session>([['tui:local', s]]);
    persistSessions(map, env);

    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      surface: s.surface,
      actorId: s.actorId,
      tier: 3,
      grantedAt: s.grantedAt,
      expiresAt: s.expiresAt,
    });
  });

  it('roundtrips multiple sessions across surfaces', () => {
    const sessions: [string, Tier3Session][] = [
      ['tui:local', session({ surface: 'tui', actorId: 'local' })],
      ['telegram:42', session({ surface: 'telegram', actorId: '42' })],
      ['cli:operator', session({ surface: 'cli', actorId: 'operator' })],
    ];
    persistSessions(new Map(sessions), env);
    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(3);
    expect(restored.map(r => r.surface).sort()).toEqual(['cli', 'telegram', 'tui']);
  });

  it('drops expired entries on load', () => {
    const future = session({ expiresAt: Date.now() + 60_000 });
    const past = session({
      actorId: 'expired',
      grantedAt: Date.now() - 10 * 60 * 60 * 1000,
      expiresAt: Date.now() - 7 * 60 * 60 * 1000,
    });
    persistSessions(
      new Map<string, Tier3Session>([
        ['tui:local', future],
        ['tui:expired', past],
      ]),
      env,
    );
    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(1);
    expect(restored[0].actorId).toBe('local');
  });

  it('writes file with 0600 permissions', () => {
    persistSessions(new Map([['tui:local', session()]]), env);
    const filePath = getPersistencePath(env);
    const stat = fs.statSync(filePath);
    // 0o600 = owner read+write only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns empty array when file missing', () => {
    const restored = loadPersistedSessions(env);
    expect(restored).toEqual([]);
  });

  it('returns empty array on corrupt JSON', () => {
    const filePath = getPersistencePath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not-valid-json{{{');
    const restored = loadPersistedSessions(env);
    expect(restored).toEqual([]);
  });

  it('drops entries with missing/invalid fields silently', () => {
    const filePath = getPersistencePath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        { surface: 'tui', actorId: 'local', tier: 3, grantedAt: 1, expiresAt: Date.now() + 60_000 },
        { surface: 'unknown-surface', actorId: 'x', tier: 3, grantedAt: 1, expiresAt: Date.now() + 60_000 },
        { tier: 2 }, // wrong tier
        null,
        { surface: 'tui', actorId: '', tier: 3, grantedAt: 1, expiresAt: 1 }, // empty actor
      ]),
    );
    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(1);
    expect(restored[0].actorId).toBe('local');
  });

  it('honors MEMPHIS_TIER3_PERSIST=0 (skip save)', () => {
    const disabledEnv = { ...env, MEMPHIS_TIER3_PERSIST: '0' };
    persistSessions(new Map([['tui:local', session()]]), disabledEnv);
    const filePath = getPersistencePath(disabledEnv);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('honors MEMPHIS_TIER3_PERSIST=0 (skip load)', () => {
    persistSessions(new Map([['tui:local', session()]]), env);
    const disabledEnv = { ...env, MEMPHIS_TIER3_PERSIST: '0' };
    const restored = loadPersistedSessions(disabledEnv);
    expect(restored).toEqual([]);
  });

  it('clears persisted file', () => {
    persistSessions(new Map([['tui:local', session()]]), env);
    expect(fs.existsSync(getPersistencePath(env))).toBe(true);
    clearPersistedSessions(env);
    expect(fs.existsSync(getPersistencePath(env))).toBe(false);
  });

  it('atomic write via tmp + rename leaves no orphan tmp file', () => {
    persistSessions(new Map([['tui:local', session()]]), env);
    const filePath = getPersistencePath(env);
    const tmpPath = filePath + '.tmp';
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});
