import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI skills', () => {
  it('lists the skill marketplace catalog as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-cli-skills-list-'));

    const out = await runCli(['skills', 'list', '--json'], {
      env: { MEMPHIS_DATA_DIR: dir },
    });

    const data = JSON.parse(out) as {
      manifests: Array<{ id: string; source: { kind: string } }>;
      catalogErrors: Array<{ path: string; detail: string }>;
    };

    expect(data.manifests.map((item) => item.id)).toEqual([
      'deploy-troubleshooter',
      'memory-curator',
      'self-mod-operator',
    ]);
    expect(data.manifests.find((item) => item.id === 'deploy-troubleshooter')?.source.kind).toBe(
      'builtin',
    );
    expect(data.catalogErrors).toEqual([]);
  });

  it('creates a skill scaffold under the Memphis drafts directory by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-cli-skills-create-'));

    const out = await runCli(
      [
        'skills',
        'create',
        'incident-handoff',
        '--name',
        'Incident Handoff',
        '--description',
        'Collect incident context and package a clean operator handoff.',
        '--tools',
        'memphis_search,memphis_test',
        '--json',
      ],
      {
        env: { MEMPHIS_DATA_DIR: dir },
      },
    );

    const data = JSON.parse(out) as {
      outputDir: string;
      manifestPath: string;
      skillPath: string;
      ref: { manifest: { id: string } };
    };

    expect(data.ref.manifest.id).toBe('incident-handoff');
    expect(data.outputDir).toBe(join(dir, 'skills', 'drafts', 'incident-handoff'));
    expect(existsSync(data.manifestPath)).toBe(true);
    expect(existsSync(data.skillPath)).toBe(true);
  });

  it('imports a scaffolded skill and installs it into the runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-cli-skills-install-'));
    const env = { MEMPHIS_DATA_DIR: dir };

    const created = JSON.parse(
      await runCli(
        [
          'skills',
          'create',
          'incident-handoff',
          '--name',
          'Incident Handoff',
          '--description',
          'Collect incident context and package a clean operator handoff.',
          '--tools',
          'memphis_search,memphis_test',
          '--json',
        ],
        { env },
      ),
    ) as { manifestPath: string };

    await runCli(['skills', 'import', '--file', created.manifestPath, '--json'], { env });

    const installOut = await runCli(['skills', 'install', 'incident-handoff', '--json'], { env });
    const installData = JSON.parse(installOut) as {
      record: { id: string; installedPath: string };
      install: { skillPath: string };
    };

    expect(installData.record.id).toBe('incident-handoff');
    expect(installData.record.installedPath).toBe(join(dir, 'skills', 'installed', 'incident-handoff'));
    expect(existsSync(installData.install.skillPath)).toBe(true);

    const showOut = await runCli(['skills', 'show', 'incident-handoff', '--json'], { env });
    const showData = JSON.parse(showOut) as {
      manifest: { id: string; tools: string[] };
      installedRecord: { installed: boolean };
    };

    expect(showData.manifest.id).toBe('incident-handoff');
    expect(showData.manifest.tools).toEqual(['memphis_search', 'memphis_test']);
    expect(showData.installedRecord.installed).toBe(true);
  });
});
