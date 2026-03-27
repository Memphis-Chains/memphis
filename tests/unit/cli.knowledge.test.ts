import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI knowledge', () => {
  it('reports workspace-context availability in JSON status output', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-knowledge-data-'));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'memphis-cli-knowledge-workspace-'));
    mkdirSync(join(workspaceRoot, '.memphis'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, '.memphis', 'context.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          workspaceName: 'brain',
          purpose: 'Knowledge CLI workspace',
          directories: {
            memory: 'memory',
            notes: 'notes',
            apps: 'apps',
          },
          preferredFormats: ['markdown', 'json'],
          rules: ['Prefer local-first truth.'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const output = await runCli(['knowledge', 'status', '--json'], {
      cwd: workspaceRoot,
      env: { MEMPHIS_DATA_DIR: dataDir },
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      mode: string;
      summary: { loaded: number };
      sources: Array<{ id: string; available: boolean }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('knowledge.status');
    expect(parsed.summary.loaded).toBeGreaterThan(0);
    expect(parsed.sources).toContainEqual(
      expect.objectContaining({
        id: 'workspace-context',
        available: true,
      }),
    );
  });

  it('queries workspace context through the CLI knowledge seam', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-knowledge-query-data-'));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'memphis-cli-knowledge-query-workspace-'));
    mkdirSync(join(workspaceRoot, '.memphis'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, '.memphis', 'context.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          workspaceName: 'brain',
          purpose: 'Shared Memphis workspace for supervised, auditable agent work.',
          directories: {
            memory: 'memory',
            notes: 'notes',
            apps: 'apps',
          },
          preferredFormats: ['markdown', 'json'],
          rules: ['Prefer local-first, auditable, and reversible changes.'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const output = await runCli(
      ['knowledge', 'query', '--topic', 'workspace', '--source', 'workspace-context', '--json'],
      {
        cwd: workspaceRoot,
        env: { MEMPHIS_DATA_DIR: dataDir },
      },
    );
    const parsed = JSON.parse(output) as {
      ok: boolean;
      mode: string;
      source: string | null;
      hits: Array<{ sourceId: string; section: string; snippet: string }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('knowledge.query');
    expect(parsed.source).toBe('workspace-context');
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits[0]?.sourceId).toBe('workspace-context');
    expect(parsed.hits[0]?.snippet).toContain('workspace');
  });
});
