import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KnowledgeService } from '../../src/modules/knowledge/service.js';

describe('KnowledgeService', () => {
  it('reports workspace and repo-local knowledge sources with availability metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-knowledge-service-'));
    const workspaceRoot = join(root, 'workspace');
    const repoRoot = join(root, 'repo');

    mkdirSync(join(workspaceRoot, '.memphis'), { recursive: true });
    mkdirSync(join(repoRoot, 'memory'), { recursive: true });

    writeFileSync(
      join(workspaceRoot, '.memphis', 'context.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          workspaceName: 'brain',
          purpose: 'Knowledge seam coverage workspace',
          directories: {
            memory: 'memory',
            notes: 'notes',
            apps: 'apps',
          },
          preferredFormats: ['markdown', 'json'],
          rules: ['Keep local-first truth.', 'Use auditable notes.'],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(repoRoot, 'memory', 'architecture-model-2026-03-27.md'),
      '# Rust TUI\n\nRust TUI is the native operator console.\n',
      'utf8',
    );
    writeFileSync(
      join(repoRoot, 'memory', 'memphis-knowledge-synth-2026-03-27.md'),
      '# Workspace\n\nWorkspace context is local-first and auditable.\n',
      'utf8',
    );

    const result = new KnowledgeService({ repoRoot, workspaceRoot }).buildStatus();

    expect(result.summary.loaded).toBe(3);
    expect(result.summary.missingOptional).toBe(1);
    expect(result.summary.missingRequired).toBe(0);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace-context',
          available: true,
        }),
        expect.objectContaining({
          id: 'architecture-model',
          available: true,
        }),
        expect.objectContaining({
          id: 'knowledge-synth',
          available: true,
        }),
        expect.objectContaining({
          id: 'long-term-memory',
          available: false,
        }),
      ]),
    );
  });

  it('prefers heading-aligned sections when ranking knowledge query hits', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-knowledge-query-'));
    const workspaceRoot = join(root, 'workspace');
    const repoRoot = join(root, 'repo');

    mkdirSync(join(workspaceRoot, '.memphis'), { recursive: true });
    mkdirSync(join(repoRoot, 'memory'), { recursive: true });

    writeFileSync(
      join(workspaceRoot, '.memphis', 'context.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          workspaceName: 'brain',
          purpose: 'Workspace focused on knowledge tests',
          directories: {
            memory: 'memory',
            notes: 'notes',
            apps: 'apps',
          },
          preferredFormats: ['markdown'],
          rules: ['Remember workspace truth.'],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(repoRoot, 'memory', 'architecture-model-2026-03-27.md'),
      '# Rust TUI\n\nRust TUI owns the operator console and native cockpit.\n',
      'utf8',
    );
    writeFileSync(
      join(repoRoot, 'memory', 'memphis-knowledge-synth-2026-03-27.md'),
      '# Notes\n\nThe operator console mentions Rust TUI only in passing.\n',
      'utf8',
    );

    const result = new KnowledgeService({ repoRoot, workspaceRoot }).query('Rust TUI', {
      limit: 3,
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]).toMatchObject({
      sourceId: 'architecture-model',
      section: 'Rust TUI',
    });
  });
});
