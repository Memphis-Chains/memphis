/**
 * Tests for the operator passphrase gate (sudo-like auth).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorizeSession,
  clearSessionAuth,
  generateSalt,
  hashWithSalt,
  isGatedOperation,
  isOperatorConfigured,
  isSessionAuthorized,
  loadOperatorConfig,
  saveOperatorConfig,
  validateOperatorPassphrase,
  type OperatorConfig,
} from '../../src/infra/auth/operator-gate.js';
import type { CliArgs } from '../../src/infra/cli/types.js';

let testDir: string;
let testEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `memphis-op-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  testEnv = { MEMPHIS_DATA_DIR: testDir };
  clearSessionAuth();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('hashing', () => {
  it('generates unique salts', () => {
    const s1 = generateSalt();
    const s2 = generateSalt();
    expect(s1).not.toBe(s2);
    expect(s1).toHaveLength(32); // 16 bytes as hex
  });

  it('produces deterministic hash for same salt+value', () => {
    const salt = generateSalt();
    const h1 = hashWithSalt('test', salt);
    const h2 = hashWithSalt('test', salt);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA256 hex
  });

  it('produces different hash for different salt', () => {
    const h1 = hashWithSalt('test', 'salt-a');
    const h2 = hashWithSalt('test', 'salt-b');
    expect(h1).not.toBe(h2);
  });
});

describe('config persistence', () => {
  it('returns null when no config exists', () => {
    expect(loadOperatorConfig(testEnv)).toBeNull();
    expect(isOperatorConfigured(testEnv)).toBe(false);
  });

  it('saves and loads config', () => {
    const salt = generateSalt();
    const config: OperatorConfig = {
      schemaVersion: 1,
      passphraseHash: hashWithSalt('my-passphrase', salt),
      salt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recoveryQuestionHint: 'Favorite color?',
      recoveryHash: hashWithSalt('blue', salt),
    };

    saveOperatorConfig(config, testEnv);
    expect(isOperatorConfigured(testEnv)).toBe(true);

    const loaded = loadOperatorConfig(testEnv);
    expect(loaded).not.toBeNull();
    expect(loaded!.passphraseHash).toBe(config.passphraseHash);
    expect(loaded!.salt).toBe(config.salt);
    expect(loaded!.recoveryQuestionHint).toBe('Favorite color?');
  });
});

describe('validation', () => {
  it('validates correct passphrase', () => {
    const salt = generateSalt();
    const config: OperatorConfig = {
      schemaVersion: 1,
      passphraseHash: hashWithSalt('correct-pass', salt),
      salt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recoveryQuestionHint: 'Q?',
      recoveryHash: hashWithSalt('A', salt),
    };
    saveOperatorConfig(config, testEnv);

    expect(validateOperatorPassphrase('correct-pass', testEnv)).toBe(true);
  });

  it('rejects wrong passphrase', () => {
    const salt = generateSalt();
    const config: OperatorConfig = {
      schemaVersion: 1,
      passphraseHash: hashWithSalt('correct-pass', salt),
      salt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recoveryQuestionHint: 'Q?',
      recoveryHash: hashWithSalt('A', salt),
    };
    saveOperatorConfig(config, testEnv);

    expect(validateOperatorPassphrase('wrong-pass', testEnv)).toBe(false);
  });

  it('returns false when not configured', () => {
    expect(validateOperatorPassphrase('anything', testEnv)).toBe(false);
  });
});

describe('session cache', () => {
  it('starts unauthorized', () => {
    expect(isSessionAuthorized()).toBe(false);
  });

  it('authorizes and remembers', () => {
    authorizeSession();
    expect(isSessionAuthorized()).toBe(true);
  });

  it('clears session', () => {
    authorizeSession();
    clearSessionAuth();
    expect(isSessionAuthorized()).toBe(false);
  });

  it('expires after TTL', () => {
    vi.useFakeTimers();
    authorizeSession();
    expect(isSessionAuthorized()).toBe(true);

    // Advance past 15 minutes
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(isSessionAuthorized()).toBe(false);

    vi.useRealTimers();
  });
});

describe('isGatedOperation', () => {
  const baseArgs = {
    json: false,
    tui: false,
    write: false,
    save: false,
    confirmWrite: false,
    interactive: false,
    nonInteractive: false,
    force: false,
    apply: false,
    dryRun: false,
    yes: false,
    schema: false,
    verbose: false,
    vision: false,
    functions: false,
    reset: false,
    list: false,
    clean: false,
    safeMode: false,
    strictMode: false,
    runtime: false,
  } satisfies Partial<CliArgs> as CliArgs;

  it('gates vault init', () => {
    expect(isGatedOperation('vault', 'init', baseArgs)).toBe(true);
  });

  it('gates vault list', () => {
    expect(isGatedOperation('vault', 'list', baseArgs)).toBe(true);
  });

  it('gates vault get', () => {
    expect(isGatedOperation('vault', 'get', baseArgs)).toBe(true);
  });

  it('gates trust add', () => {
    expect(isGatedOperation('trust', 'add', baseArgs)).toBe(true);
  });

  it('gates trust remove', () => {
    expect(isGatedOperation('trust', 'remove', baseArgs)).toBe(true);
  });

  it('does not gate trust list', () => {
    expect(isGatedOperation('trust', 'list', baseArgs)).toBe(false);
  });

  it('gates evolve rollback', () => {
    expect(isGatedOperation('evolve', 'rollback', baseArgs)).toBe(true);
  });

  it('does not gate evolve status', () => {
    expect(isGatedOperation('evolve', 'status', baseArgs)).toBe(false);
  });

  it('gates configure', () => {
    expect(isGatedOperation('configure', undefined, baseArgs)).toBe(true);
  });

  it('gates backup with --restore', () => {
    expect(isGatedOperation('backup', undefined, { ...baseArgs, restore: 'snap-1' })).toBe(true);
  });

  it('does not gate backup without flags', () => {
    expect(isGatedOperation('backup', undefined, baseArgs)).toBe(false);
  });

  it('gates reset with --runtime', () => {
    expect(isGatedOperation('reset', undefined, { ...baseArgs, runtime: true })).toBe(true);
  });

  it('returns false for unknown commands', () => {
    expect(isGatedOperation('doctor', undefined, baseArgs)).toBe(false);
    expect(isGatedOperation('health', undefined, baseArgs)).toBe(false);
    expect(isGatedOperation(undefined, undefined, baseArgs)).toBe(false);
  });
});
