/**
 * Tier-3 session persistence — load/save/expire/feature-gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPersistedSessions,
  getPersistencePath,
  loadPersistedSessions,
  persistSessions,
} from '../../src/security/tier3-session-persistence.js';
import { TIER_3_TTL_MS, type Tier3LifecycleEvent, type Tier3Session } from '../../src/security/tier3-session.js';

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
    const now = Date.now();
    const recentGrant = now - 1_000; // 1s ago — realistic
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        { surface: 'tui', actorId: 'local', tier: 3, grantedAt: recentGrant, expiresAt: recentGrant + 60_000 },
        { surface: 'unknown-surface', actorId: 'x', tier: 3, grantedAt: recentGrant, expiresAt: recentGrant + 60_000 },
        { tier: 2 }, // wrong tier
        null,
        { surface: 'tui', actorId: '', tier: 3, grantedAt: recentGrant, expiresAt: recentGrant + 60_000 }, // empty actor — non-expired so the empty-actor guard fires, not the expiry filter
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

  it('rejects tampered expiresAt beyond grantedAt + TIER_3_TTL_MS (replay defense)', () => {
    // Hand-crafted state file claiming permanent elevation — bypasses
    // the load-time freshness check (expiresAt > now()) but should be
    // rejected by validateSession's TTL clamp.
    const filePath = getPersistencePath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const grantedAt = Date.now();
    const tampered: Tier3Session = {
      surface: 'tui',
      actorId: 'attacker',
      tier: 3,
      grantedAt,
      // Far-future expiry that would otherwise grant permanent elevation
      expiresAt: grantedAt + TIER_3_TTL_MS + 60_000,
    };
    fs.writeFileSync(filePath, JSON.stringify([tampered]));
    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(0);
  });

  it('rejects tampered grantedAt in the future (clock-skew defense)', () => {
    // Without bounding grantedAt, an attacker could write a future
    // grantedAt so the TTL clamp itself stretches arbitrarily forward.
    // Anything more than 60s ahead of now() is treated as tampering.
    const filePath = getPersistencePath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const farFuture = Date.now() + 3600_000; // 1h ahead = clearly tampered
    const tampered: Tier3Session = {
      surface: 'tui',
      actorId: 'attacker',
      tier: 3,
      grantedAt: farFuture,
      expiresAt: farFuture + TIER_3_TTL_MS,
    };
    fs.writeFileSync(filePath, JSON.stringify([tampered]));
    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(0);
  });

  it('accepts legitimate session within TTL bounds', () => {
    // Sanity check — the TTL clamp shouldn't reject normal grants.
    const grantedAt = Date.now() - 60_000; // granted 1 min ago
    const legit: Tier3Session = {
      surface: 'tui',
      actorId: 'real-operator',
      tier: 3,
      grantedAt,
      expiresAt: grantedAt + TIER_3_TTL_MS, // exactly at the cap
    };
    persistSessions(new Map([['tui:real-operator', legit]]), env);
    const restored = loadPersistedSessions(env);
    expect(restored).toHaveLength(1);
    expect(restored[0].actorId).toBe('real-operator');
  });

  it('symlink defense — unlinks pre-existing tmp before write', () => {
    // Simulate an attacker pre-planting the .tmp path as a symlink to
    // an arbitrary target. After persistSessions(), the symlink should
    // be gone and the canonical file should be a regular file at
    // filePath (target untouched).
    const filePath = getPersistencePath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    const attackerTarget = path.join(tmpDir, 'attacker-decoy.txt');
    fs.writeFileSync(attackerTarget, 'should-not-be-clobbered');
    fs.symlinkSync(attackerTarget, tmpPath);

    persistSessions(new Map([['tui:local', session()]]), env);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.lstatSync(filePath).isFile()).toBe(true);
    expect(fs.readFileSync(attackerTarget, 'utf-8')).toBe('should-not-be-clobbered');
  });
});

describe('hydrateFromDisk side effects (P1 #5 follow-up — codex findings)', () => {
  // Hydrate is a module-load side effect. Tests use vi.resetModules() +
  // dynamic import after seeding disk to exercise it cleanly.

  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier3-hydrate-'));
    auditPath = path.join(tmpDir, 'security-audit.jsonl');
    vi.resetModules();
    // Block 1853 incident guard (2026-05-12) — this suite exercises
    // the real audit path; opt in so writes proceed to the tmpdir.
    process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE = '1';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.resetModules();
    delete process.env.MEMPHIS_HOME;
    delete process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH;
    delete process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE;
  });

  it('reschedules lifecycle timers for restored sessions', async () => {
    process.env.MEMPHIS_HOME = tmpDir;
    process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = auditPath;

    const persistMod = await import('../../src/security/tier3-session-persistence.js');
    const grantedAt = Date.now();
    const seed: Tier3Session = {
      surface: 'tui',
      actorId: 'hydrate-actor',
      tier: 3,
      grantedAt,
      expiresAt: grantedAt + 60_000, // expires in 60s
    };
    persistMod.persistSessions(
      new Map<string, Tier3Session>([['tui:hydrate-actor', seed]]),
      process.env,
    );

    vi.useFakeTimers({ now: grantedAt });

    const tier3Mod = await import('../../src/security/tier3-session.js');
    const events: Tier3LifecycleEvent[] = [];
    const unsubscribe = tier3Mod.subscribeTier3Lifecycle((e) => events.push(e));
    try {
      await vi.advanceTimersByTimeAsync(70_000); // past expiry
      const kinds = events
        .filter((e) => e.session.actorId === 'hydrate-actor')
        .map((e) => e.kind);
      expect(kinds).toContain('expired');
    } finally {
      unsubscribe();
    }
  });

  it('emits tier3-hydrate audit event per restored session', async () => {
    process.env.MEMPHIS_HOME = tmpDir;
    process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = auditPath;

    const persistMod = await import('../../src/security/tier3-session-persistence.js');
    const grantedAt = Date.now();
    const seed: Tier3Session = {
      surface: 'telegram',
      actorId: 'hydrate-actor-audit',
      tier: 3,
      grantedAt,
      expiresAt: grantedAt + 60_000,
    };
    persistMod.persistSessions(
      new Map<string, Tier3Session>([['telegram:hydrate-actor-audit', seed]]),
      process.env,
    );

    // Importing the module triggers hydrateFromDisk side effect.
    await import('../../src/security/tier3-session.js');

    // Audit file should contain a tier3-hydrate entry with source: disk.
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs
      .readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> });
    const hydrate = lines.find((l) => l.action === 'tier3-hydrate');
    expect(hydrate).toBeDefined();
    expect(hydrate?.details?.source).toBe('disk');
    expect(hydrate?.details?.actorId).toBe('hydrate-actor-audit');
    expect(hydrate?.details?.surface).toBe('telegram');
  });
});
