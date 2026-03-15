import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI workspace/context', () => {
  it('initializes a Memphis workspace scaffold with managed context files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-workspace-init-'));
    const workspaceRoot = join(dir, 'brain');

    const out = await runCli(['workspace', 'init', workspaceRoot, '--json']);
    const data = JSON.parse(out) as {
      action: string;
      root: string;
      contextPath: string;
      statuses: Array<{ path: string; status: string }>;
    };

    expect(data.action).toBe('workspace.init');
    expect(data.root).toBe(workspaceRoot);
    expect(existsSync(join(workspaceRoot, '.memphis', 'context.json'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'memory'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'notes'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'apps'))).toBe(true);
    expect(data.statuses.some((item) => item.path.endsWith('AGENTS.md'))).toBe(true);
  });

  it('syncs Memphis-managed context blocks while preserving local notes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-context-sync-'));
    const workspaceRoot = join(dir, 'brain');

    await runCli(['workspace', 'init', workspaceRoot, '--json']);

    const contextPath = join(workspaceRoot, '.memphis', 'context.json');
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
      purpose: string;
      rules: string[];
    };
    context.purpose = 'Updated purpose for context sync coverage.';
    context.rules.push('Keep sync-safe local notes below the managed block.');
    writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

    const agentsPath = join(workspaceRoot, 'AGENTS.md');
    writeFileSync(
      agentsPath,
      `${readFileSync(agentsPath, 'utf8')}\nCustom note stays here.\n`,
      'utf8',
    );

    const out = await runCli(['context', 'sync', workspaceRoot, '--json']);
    const data = JSON.parse(out) as {
      action: string;
      statuses: Array<{ path: string; status: string }>;
    };
    const agents = readFileSync(agentsPath, 'utf8');

    expect(data.action).toBe('context.sync');
    expect(data.statuses.some((item) => item.path.endsWith('AGENTS.md'))).toBe(true);
    expect(agents).toContain('Updated purpose for context sync coverage.');
    expect(agents).toContain('Keep sync-safe local notes below the managed block.');
    expect(agents).toContain('Custom note stays here.');
  });

  it('skips existing context files without Memphis markers unless forced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-context-force-'));
    const workspaceRoot = join(dir, 'brain');

    await runCli(['workspace', 'init', workspaceRoot, '--json']);
    const claudePath = join(workspaceRoot, 'CLAUDE.md');
    writeFileSync(claudePath, '# Custom Claude Notes\n\nLeave me alone.\n', 'utf8');

    const out = await runCli(['context', 'sync', workspaceRoot, '--json']);
    const data = JSON.parse(out) as {
      statuses: Array<{ path: string; status: string; detail: string }>;
    };

    expect(data.statuses).toContainEqual(
      expect.objectContaining({
        path: claudePath,
        status: 'skipped',
      }),
    );

    await runCli(['context', 'sync', workspaceRoot, '--force', '--json']);
    expect(readFileSync(claudePath, 'utf8')).toContain('<!-- memphis:context:start -->');
  });
});
