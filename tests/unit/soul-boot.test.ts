/**
 * Unit tests for soul boot detection and prompt generation.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSoulBootPrompt,
  buildSoulManifestFragment,
  buildSoulMemoryFragment,
  isSoulBootNeeded,
} from '../../src/soul/boot.js';
import { emptySoulMemory } from '../../src/soul/memory.js';
import type { SoulManifest, SoulMemory } from '../../src/soul/types.js';

function fakeManifest(overrides?: Partial<SoulManifest>): SoulManifest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-03-22T00:00:00.000Z',
    identity: {
      agentName: 'Memphis',
      ownerName: 'TestOwner',
      runtimeMode: 'dev-local',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    capabilities: {
      tools: ['memphis_journal', 'memphis_soul_read'],
      chains: ['journal', 'cases'],
      channels: ['cli', 'mcp'],
      providers: ['ollama'],
      rustBridge: false,
    },
    boundaries: {
      tier0: { auth: 'none', scope: 'soul memory, journal' },
      tier1: { auth: 'api_token', scope: 'config' },
      tier2: { auth: 'vault_passphrase', scope: 'source code' },
    },
    evolution: {
      autoApproveReflections: true,
      requirePassphraseForTier2: true,
      snapshotBeforeEvolution: true,
    },
    ...overrides,
  };
}

function populatedMemory(): SoulMemory {
  const memory = emptySoulMemory();
  memory.user.name = 'Alice';
  memory.user.languages = ['en'];
  memory.user.preferences = ['concise'];
  memory.self.learnings = ['user prefers TypeScript'];
  return memory;
}

describe('soul boot', () => {
  describe('buildSoulManifestFragment', () => {
    it('wraps manifest in <soul_manifest> XML tags', () => {
      const fragment = buildSoulManifestFragment(fakeManifest());
      expect(fragment).toContain('<soul_manifest>');
      expect(fragment).toContain('</soul_manifest>');
    });

    it('includes agent identity fields', () => {
      const fragment = buildSoulManifestFragment(fakeManifest());
      expect(fragment).toContain('"agent": "Memphis"');
      expect(fragment).toContain('"owner": "TestOwner"');
      expect(fragment).toContain('"mode": "dev-local"');
    });

    it('includes tools and chains', () => {
      const fragment = buildSoulManifestFragment(fakeManifest());
      expect(fragment).toContain('memphis_journal');
      expect(fragment).toContain('journal');
    });

    it('includes boundary tiers', () => {
      const fragment = buildSoulManifestFragment(fakeManifest());
      expect(fragment).toContain('tier0');
      expect(fragment).toContain('tier1');
      expect(fragment).toContain('tier2');
    });
  });

  describe('buildSoulMemoryFragment', () => {
    it('wraps memory in <soul_memory> XML tags', () => {
      const fragment = buildSoulMemoryFragment(populatedMemory());
      expect(fragment).toContain('<soul_memory>');
      expect(fragment).toContain('</soul_memory>');
    });

    it('includes user data', () => {
      const fragment = buildSoulMemoryFragment(populatedMemory());
      expect(fragment).toContain('"name": "Alice"');
      expect(fragment).toContain('"concise"');
    });

    it('includes self learnings', () => {
      const fragment = buildSoulMemoryFragment(populatedMemory());
      expect(fragment).toContain('user prefers TypeScript');
    });
  });

  describe('buildSoulBootPrompt', () => {
    it('wraps in <soul_boot> XML tags', () => {
      const prompt = buildSoulBootPrompt(fakeManifest());
      expect(prompt).toContain('<soul_boot>');
      expect(prompt).toContain('</soul_boot>');
    });

    it('includes agent name', () => {
      const prompt = buildSoulBootPrompt(fakeManifest());
      expect(prompt).toContain("Memphis's first conversation");
    });

    it('asks for user preferences', () => {
      const prompt = buildSoulBootPrompt(fakeManifest());
      expect(prompt).toContain('name');
      expect(prompt).toContain('languages');
      expect(prompt).toContain('Communication style');
    });

    it('mentions memphis_soul_write', () => {
      const prompt = buildSoulBootPrompt(fakeManifest());
      expect(prompt).toContain('memphis_soul_write');
    });
  });

  describe('isSoulBootNeeded', () => {
    it('returns true when no soul memory file exists', () => {
      // getConfigPath reads process.env.MEMPHIS_DATA_DIR, not the rawEnv param
      const prev = process.env.MEMPHIS_DATA_DIR;
      const tmpDir = '/tmp/nonexistent-soul-boot-test-' + Date.now();
      process.env.MEMPHIS_DATA_DIR = tmpDir;
      try {
        expect(isSoulBootNeeded()).toBe(true);
      } finally {
        if (prev !== undefined) {
          process.env.MEMPHIS_DATA_DIR = prev;
        } else {
          delete process.env.MEMPHIS_DATA_DIR;
        }
      }
    });
  });
});
