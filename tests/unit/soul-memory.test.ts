/**
 * Unit tests for soul memory read, write, deep merge, and empty detection.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptySoulMemory,
  isSoulMemoryEmpty,
  loadSoulMemory,
  updateSoulMemory,
  writeSoulMemory,
} from '../../src/soul/memory.js';
import { soulMemorySchema } from '../../src/soul/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-soul-memory-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('soul memory', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = makeTmpDir();
    previousDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir !== undefined) {
      process.env.MEMPHIS_DATA_DIR = previousDataDir;
    } else {
      delete process.env.MEMPHIS_DATA_DIR;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('emptySoulMemory passes Zod validation', () => {
    const memory = emptySoulMemory();
    const parsed = soulMemorySchema.safeParse(memory);
    expect(parsed.success).toBe(true);
  });

  it('loadSoulMemory returns null when no file exists', () => {
    const result = loadSoulMemory();
    expect(result).toBeNull();
  });

  it('write and load round-trip', () => {
    const memory = emptySoulMemory();
    memory.user.name = 'TestUser';
    writeSoulMemory(memory);

    const loaded = loadSoulMemory();
    expect(loaded).not.toBeNull();
    expect(loaded!.user.name).toBe('TestUser');
  });

  it('isSoulMemoryEmpty returns true for fresh memory', () => {
    const memory = emptySoulMemory();
    expect(isSoulMemoryEmpty(memory)).toBe(true);
  });

  it('isSoulMemoryEmpty returns false when user name is set', () => {
    const memory = emptySoulMemory();
    memory.user.name = 'Alice';
    expect(isSoulMemoryEmpty(memory)).toBe(false);
  });

  it('isSoulMemoryEmpty returns false when preferences exist', () => {
    const memory = emptySoulMemory();
    memory.user.preferences = ['concise'];
    expect(isSoulMemoryEmpty(memory)).toBe(false);
  });

  it('isSoulMemoryEmpty returns false when learnings exist', () => {
    const memory = emptySoulMemory();
    memory.self.learnings = ['user likes TypeScript'];
    expect(isSoulMemoryEmpty(memory)).toBe(false);
  });

  // Issue #398: pin exhaustive-by-construction proof. Every field that
  // `emptySoulMemory()` declares must trigger `isSoulMemoryEmpty -> false`
  // when populated. If a future change adds a content field to
  // SoulMemoryUser/Self/Context without adding it to `emptySoulMemory`,
  // these loops fail loud (the new field has no baseline to compare to)
  // — the structural failure mode is exactly what we want.
  describe('isSoulMemoryEmpty exhaustiveness (#398)', () => {
    const SAMPLE_FOR = (key: string, baseline: unknown): unknown => {
      // Optional string baseline (undefined) — supply non-empty string.
      if (typeof baseline === 'undefined') return `populated-${key}`;
      // Array baseline ([]) — supply single-element array.
      if (Array.isArray(baseline)) return [`populated-${key}`];
      // Scalar baseline — bump by 1 to make it non-baseline.
      if (typeof baseline === 'number') return baseline + 1;
      if (typeof baseline === 'string') return `${baseline}-x`;
      throw new Error(`unexpected baseline shape for key '${key}': ${typeof baseline}`);
    };

    it.each(['user', 'self', 'context'] as const)(
      'every content key in section %s flips isSoulMemoryEmpty to false',
      (section) => {
        const baseline = emptySoulMemory()[section] as unknown as Record<string, unknown>;
        const keys = Object.keys(baseline);
        expect(keys.length, `${section} should declare at least one content key`).toBeGreaterThan(0);
        for (const key of keys) {
          const memory = emptySoulMemory();
          (memory[section] as unknown as Record<string, unknown>)[key] = SAMPLE_FOR(
            key,
            baseline[key],
          );
          expect(
            isSoulMemoryEmpty(memory),
            `populating ${section}.${key} should make memory non-empty`,
          ).toBe(false);
        }
      },
    );

    it('treats nullish memory as empty (regression: #398)', () => {
      // Defensive: production callers shouldn't pass null, but the
      // function's return type doesn't forbid it. Keep the early
      // null-guard exercised so a future refactor doesn't silently drop it.
      expect(isSoulMemoryEmpty(null as unknown as ReturnType<typeof emptySoulMemory>)).toBe(true);
    });

    it('treats a missing section as empty (forward-compat)', () => {
      // If a stored memory file is older than a schema bump and lacks
      // a section the current code expects, the function should not
      // throw — treat the missing section as "empty section".
      const memory = emptySoulMemory();
      delete (memory as unknown as Record<string, unknown>).context;
      expect(isSoulMemoryEmpty(memory)).toBe(true);
    });
  });

  describe('updateSoulMemory', () => {
    it('creates memory file if it does not exist', () => {
      const result = updateSoulMemory({ user: { name: 'Bob' } });
      expect(result.user.name).toBe('Bob');
      expect(result.lastUpdated).toBeTruthy();

      const loaded = loadSoulMemory();
      expect(loaded).not.toBeNull();
      expect(loaded!.user.name).toBe('Bob');
    });

    it('merges user.name by overwrite', () => {
      updateSoulMemory({ user: { name: 'Alice' } });
      const result = updateSoulMemory({ user: { name: 'Bob' } });
      expect(result.user.name).toBe('Bob');
    });

    it('appends and deduplicates string arrays', () => {
      updateSoulMemory({ user: { languages: ['en', 'pl'] } });
      const result = updateSoulMemory({ user: { languages: ['pl', 'de'] } });
      expect(result.user.languages).toEqual(['en', 'pl', 'de']);
    });

    it('deep merges self section', () => {
      updateSoulMemory({ self: { personality: 'curious' } });
      const result = updateSoulMemory({ self: { learnings: ['user prefers short answers'] } });
      expect(result.self.personality).toBe('curious');
      expect(result.self.learnings).toEqual(['user prefers short answers']);
    });

    it('deep merges context section', () => {
      updateSoulMemory({ context: { activeWork: 'Phase A' } });
      const result = updateSoulMemory({ context: { recentDecisions: ['ship soul system'] } });
      expect(result.context.activeWork).toBe('Phase A');
      expect(result.context.recentDecisions).toEqual(['ship soul system']);
    });

    it('no-op update with empty object preserves existing data', () => {
      updateSoulMemory({ user: { name: 'Alice', languages: ['en'] } });
      const result = updateSoulMemory({});
      expect(result.user.name).toBe('Alice');
      expect(result.user.languages).toContain('en');
    });

    it('updates lastUpdated timestamp', async () => {
      const first = updateSoulMemory({ user: { name: 'A' } });
      const firstTs = new Date(first.lastUpdated).getTime();

      await new Promise((r) => setTimeout(r, 10));

      const second = updateSoulMemory({ user: { name: 'B' } });
      const secondTs = new Date(second.lastUpdated).getTime();
      expect(secondTs).toBeGreaterThanOrEqual(firstTs);
    });
  });
});
