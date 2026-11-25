/**
 * The skill loader must dry-run before it installs anything.
 *
 * Postmortem item B2 (docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md):
 * the loader wrote two directories and two files per skill with no step in
 * between that could say what it was about to do. The operator who wanted
 * to know "where does this skill land, and what does it overwrite?" had
 * exactly one way to find out: run the install.
 *
 * What has to hold:
 *   - the plan writes nothing;
 *   - the install writes EXACTLY what the plan said — same paths, same
 *     bytes, nothing else;
 *   - the CLI's --dry-run prints that plan and touches no disk;
 *   - a skill that is already installed is not replaced behind the
 *     operator's back.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSkillManifest, planSkillInstallation } from '../../src/modules/skills/catalog.js';
import { runCli, runCliResult } from '../helpers/cli.js';

async function scaffoldSkill(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
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
  return created.manifestPath;
}

describe('skills install — the plan writes nothing', () => {
  it('planning an install leaves the disk untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-plan-'));
    const env = { MEMPHIS_DATA_DIR: dir };
    const manifestPath = await scaffoldSkill(dir, env);
    const ref = getSkillManifest({ file: manifestPath, rawEnv: env as NodeJS.ProcessEnv });

    const plan = planSkillInstallation(ref, { rawEnv: env as NodeJS.ProcessEnv });

    expect(plan.files.length).toBe(4);
    expect(plan.directories.length).toBe(2);
    for (const directory of plan.directories) {
      expect(existsSync(directory)).toBe(false);
    }
  });
});

describe('skills install — the install writes what the plan said', () => {
  it('every planned file exists with the planned size, and nothing else was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-apply-'));
    const env = { MEMPHIS_DATA_DIR: dir };
    const manifestPath = await scaffoldSkill(dir, env);
    await runCli(['skills', 'import', '--file', manifestPath, '--json'], { env });
    const ref = getSkillManifest({ file: manifestPath, rawEnv: env as NodeJS.ProcessEnv });

    const plan = planSkillInstallation(ref, { rawEnv: env as NodeJS.ProcessEnv });

    await runCli(['skills', 'install', 'incident-handoff', '--json'], { env });

    for (const file of plan.files) {
      expect(existsSync(file.path)).toBe(true);
      expect(statSync(file.path).size).toBe(file.bytes);
    }
    // The two skill directories hold exactly the two planned files each.
    for (const directory of plan.directories) {
      expect(readdirSync(directory).sort()).toEqual(['SKILL.md', 'manifest.json']);
    }
    // The markdown that was written is the markdown the plan carried.
    const skillFile = plan.files.find((file) => file.kind === 'skill');
    expect(skillFile).toBeDefined();
    expect(readFileSync(skillFile!.path, 'utf8')).toBe(plan.markdown);
  });
});

describe('skills install — the CLI dry-run', () => {
  it('prints the plan and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-dryrun-'));
    const env = { MEMPHIS_DATA_DIR: dir };
    const manifestPath = await scaffoldSkill(dir, env);
    await runCli(['skills', 'import', '--file', manifestPath, '--json'], { env });

    const out = await runCli(['skills', 'install', 'incident-handoff', '--dry-run', '--json'], {
      env,
    });
    const data = JSON.parse(out) as {
      dryRun: boolean;
      plan: {
        skillId: string;
        directories: string[];
        files: Array<{ path: string; kind: string; bytes: number }>;
        overwrites: boolean;
      };
    };

    expect(data.dryRun).toBe(true);
    expect(data.plan.skillId).toBe('incident-handoff');
    expect(data.plan.files.length).toBe(4);
    expect(data.plan.overwrites).toBe(false);

    // Nothing was installed.
    const installedDir = join(dir, 'skills', 'installed', 'incident-handoff');
    expect(existsSync(installedDir)).toBe(false);
  });

  it('says so when the install would replace an installed skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-dryrun-2-'));
    const env = { MEMPHIS_DATA_DIR: dir };
    const manifestPath = await scaffoldSkill(dir, env);
    await runCli(['skills', 'import', '--file', manifestPath, '--json'], { env });
    await runCli(['skills', 'install', 'incident-handoff', '--json'], { env });

    const out = await runCli(['skills', 'install', 'incident-handoff', '--dry-run', '--json'], {
      env,
    });
    const data = JSON.parse(out) as { plan: { overwrites: boolean } };
    expect(data.plan.overwrites).toBe(true);
  });

  it('refuses to replace an installed skill without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-skills-force-'));
    const env = { MEMPHIS_DATA_DIR: dir };
    const manifestPath = await scaffoldSkill(dir, env);
    await runCli(['skills', 'import', '--file', manifestPath, '--json'], { env });
    await runCli(['skills', 'install', 'incident-handoff', '--json'], { env });

    const result = await runCliResult(['skills', 'install', 'incident-handoff', '--json'], { env });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--force');

    const forced = await runCli(['skills', 'install', 'incident-handoff', '--force', '--json'], {
      env,
    });
    expect(JSON.parse(forced)).toBeTruthy();
  });
});
