import { describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';

describe('CLI ask + doctor', () => {
  it('supports ask alias with JSON output', () => {
    const out = execSync(
      'DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts ask --input "hello ask" --json',
      { encoding: 'utf8' },
    );

    const data = JSON.parse(out);
    expect(data.providerUsed).toBe('local-fallback');
    expect(data.output).toContain('hello ask');
  });

  it('doctor reports enhanced checks in JSON format', () => {
    const run = spawnSync('npx', ['tsx', 'src/infra/cli/index.ts', 'doctor', '--json'], {
      encoding: 'utf8',
    });

    expect([0, 1]).toContain(run.status ?? -1);
    const data = JSON.parse(run.stdout);
    expect(data).toHaveProperty('ok');
    expect(Array.isArray(data.checks)).toBe(true);
    const ids = data.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain('rust-version');
    expect(ids).toContain('node-version');
    expect(ids).toContain('permissions');
    expect(ids).toContain('env-file');
    expect(ids).toContain('build-artifacts');
    expect(ids).toContain('embedding-provider');
    expect(ids).toContain('mcp-service');
  });

  it('doctor prints human-readable output with indicators', () => {
    const run = spawnSync('npx', ['tsx', 'src/infra/cli/index.ts', 'doctor'], {
      encoding: 'utf8',
    });

    expect([0, 1]).toContain(run.status ?? -1);
    expect(run.stdout).toContain('memphis doctor:');
    expect(/✓|✗|⚠/.test(run.stdout)).toBe(true);
  });
});
