import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSkillScaffold,
  getSkillManifest,
  importSkillManifestFile,
  inspectSkillCatalog,
  materializeInstalledSkill,
} from '../../src/modules/skills/catalog.js';
import { recordInstalledSkill } from '../../src/modules/skills/registry.js';
import {
  buildInstalledSkillsPromptFragment,
  listInstalledSkillSummaries,
} from '../../src/modules/skills/runtime.js';

describe('skills catalog', () => {
  it('exposes built-in starter skills from the catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-catalog-'));
    const catalog = inspectSkillCatalog({ MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv);

    expect(catalog.manifests.map((item) => item.manifest.id)).toEqual([
      'deploy-troubleshooter',
      'memory-curator',
      'self-mod-operator',
    ]);
    expect(catalog.errors).toEqual([]);
  });

  it('creates, imports, and installs a file-backed skill package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-install-'));
    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;

    const scaffold = createSkillScaffold({
      id: 'incident-handoff',
      name: 'Incident Handoff',
      description: 'Collect incident context and package the final handoff cleanly.',
      tools: 'memphis_search, memphis_test',
      rawEnv,
    });

    expect(existsSync(scaffold.manifestPath)).toBe(true);
    expect(existsSync(scaffold.skillPath)).toBe(true);

    const imported = importSkillManifestFile(scaffold.manifestPath, { rawEnv });
    expect(existsSync(imported.manifestPath)).toBe(true);
    expect(existsSync(imported.skillPath)).toBe(true);

    const ref = getSkillManifest({ id: 'incident-handoff', rawEnv });
    const installed = materializeInstalledSkill(ref, { rawEnv });
    const record = recordInstalledSkill(ref, installed, rawEnv);

    expect(record.installedPath).toBe(installed.installedPath);
    expect(existsSync(installed.manifestPath)).toBe(true);
    expect(existsSync(installed.skillPath)).toBe(true);

    const installedSkills = listInstalledSkillSummaries(rawEnv);
    expect(installedSkills.map((skill) => skill.id)).toContain('incident-handoff');
    expect(installedSkills.find((skill) => skill.id === 'incident-handoff')?.tools).toEqual([
      'memphis_search',
      'memphis_test',
    ]);

    const promptFragment = buildInstalledSkillsPromptFragment(rawEnv);
    expect(promptFragment).toContain('Incident Handoff');
    expect(promptFragment).toContain('memphis_search, memphis_test');
  });
});
