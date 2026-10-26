import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEntriesForRotationOrThrow } from '../../src/infra/storage/rust-vault-adapter.js';

/**
 * Regression net for Codex P1: silent data loss on corrupt vault-entries.json.
 *
 * Before the fix, `rotateVaultMasterKey` caught JSON parse / read errors and
 * returned `[]`, which then caused rotation to overwrite the entries file
 * with an empty array — silently destroying every ciphertext record. The
 * loading logic was extracted into `loadEntriesForRotationOrThrow` so this
 * test can pin the "loud-abort" contract using the shared Rust parser without
 * needing a vault state or pepper.
 */

interface TestEnv {
  dataDir: string;
  entriesPath: string;
}

function setup(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-vault-rotate-'));
  const entriesPath = join(dataDir, 'vault-entries.json');
  return { dataDir, entriesPath };
}

function tearDown(env: TestEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
}

describe('loadEntriesForRotationOrThrow — corrupt entries file handling', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('returns empty array when entries file does not exist', () => {
    expect(loadEntriesForRotationOrThrow(env.entriesPath)).toEqual([]);
  });

  it('aborts for empty / whitespace-only files', () => {
    writeFileSync(env.entriesPath, '', 'utf8');
    expect(() => loadEntriesForRotationOrThrow(env.entriesPath)).toThrow('VAULT_ENTRIES_MALFORMED');
    writeFileSync(env.entriesPath, '   \n\n', 'utf8');
    expect(() => loadEntriesForRotationOrThrow(env.entriesPath)).toThrow('VAULT_ENTRIES_MALFORMED');
  });

  it('aborts when vault-entries.json contains invalid JSON', () => {
    writeFileSync(env.entriesPath, '{not valid json at all', 'utf8');
    expect(() => loadEntriesForRotationOrThrow(env.entriesPath)).toThrow(/VAULT_ENTRIES_MALFORMED/);
  });

  it('aborts when vault-entries.json contains a non-array JSON value', () => {
    writeFileSync(env.entriesPath, '{"oops": "object not array"}', 'utf8');
    expect(() => loadEntriesForRotationOrThrow(env.entriesPath)).toThrow(/VAULT_ENTRIES_MALFORMED/);
  });

  it('aborts when vault-entries.json is a stray primitive', () => {
    writeFileSync(env.entriesPath, '42', 'utf8');
    expect(() => loadEntriesForRotationOrThrow(env.entriesPath)).toThrow(/VAULT_ENTRIES_MALFORMED/);
  });

  it('reports a safe code without echoing invalid contents or changing the file', () => {
    const sentinel = '{"private-sentinel":';
    writeFileSync(env.entriesPath, sentinel, 'utf8');
    expect(() => loadEntriesForRotationOrThrow(env.entriesPath)).toThrow(
      'VAULT_ENTRIES_MALFORMED: vault entries are malformed',
    );
    expect(readFileSync(env.entriesPath, 'utf8')).toBe(sentinel);
  });

  it('accepts a valid array (round-trip)', () => {
    const payload = [
      {
        id: 'a',
        key: 'foo',
        encrypted: 'x',
        iv: 'y',
        tag: 'z',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    writeFileSync(env.entriesPath, JSON.stringify(payload), 'utf8');
    expect(loadEntriesForRotationOrThrow(env.entriesPath)).toEqual([
      { ...payload[0], fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
  });
});
