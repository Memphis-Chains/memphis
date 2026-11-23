/**
 * The skill catalog check — the measurement that says whether a skill in
 * the repository is the skill the runtime serves.
 *
 * ## Why
 *
 * A skill lives in two places: the repository (`skills/<id>/`) and the
 * runtime (`~/.memphis/skills/{catalog,installed}/<id>/`). The MCP server
 * reads the runtime. So a repository skill that was never materialized is
 * invisible — `memphis skills show` answers "manifest not found" and no
 * tool can reach it.
 *
 * That was the live state on this host: the HALT skill — the guard every
 * destructive operation passes through — was not a runtime skill at all,
 * and the runtime copy of `usb-grabber-feed` still described the old
 * `memphis_cron` workflow while the repository copy already described
 * `memphis_cron_script`.
 *
 * ## What this test measures
 *
 * The check is a pure function of measured facts, so the test drives it
 * with facts. Every failure case is paired with the state that makes it
 * pass: a check that cannot change its answer is not a check.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkSkillCatalog } from '../../src/infra/audit/checks.js';
import { readSkillFact } from '../../src/infra/audit/skill-facts.js';

function fact(
  id: string,
  overrides: { skillMdDigest?: string | null; manifestDigest?: string | null } = {},
): {
  id: string;
  skillMdDigest: string | null;
  manifestDigest: string | null;
  manifestUnreadable: boolean;
} {
  return {
    id,
    skillMdDigest: overrides.skillMdDigest === undefined ? `md-${id}` : overrides.skillMdDigest,
    manifestDigest: overrides.manifestDigest === undefined ? `mf-${id}` : overrides.manifestDigest,
    manifestUnreadable: false,
  };
}

describe('runtime audit · skill catalog', () => {
  it('passes when every repository skill is materialized unchanged', () => {
    const repoSkills = [fact('halt-aware-destructive-ops'), fact('remote-site-edit')];
    const result = checkSkillCatalog({
      repoSkills,
      catalogSkills: repoSkills,
      installedSkills: repoSkills,
    });

    expect(result.verdict).toBe('success');
    expect(result.id).toBe('skill-catalog');
  });

  it('fails when a repository skill never reached the runtime', () => {
    const repoSkills = [fact('halt-aware-destructive-ops'), fact('remote-site-edit')];
    const result = checkSkillCatalog({
      repoSkills,
      catalogSkills: [repoSkills[0]!],
      installedSkills: [repoSkills[0]!],
    });

    expect(result.verdict).toBe('failure');
    expect(result.details.join('\n')).toContain('remote-site-edit');
    expect(result.details.join('\n')).toContain('invisible to the MCP server');
  });

  it('fails when the runtime copy differs from the repository copy', () => {
    const repoSkills = [fact('usb-grabber-feed')];
    const result = checkSkillCatalog({
      repoSkills,
      catalogSkills: repoSkills,
      installedSkills: [fact('usb-grabber-feed', { skillMdDigest: 'md-stale' })],
    });

    expect(result.verdict).toBe('failure');
    expect(result.details.join('\n')).toContain('usb-grabber-feed');
    expect(result.details.join('\n')).toContain('SKILL.md differs');
  });

  it('fails when a repository skill has no manifest at all', () => {
    const result = checkSkillCatalog({
      repoSkills: [fact('no-manifest', { manifestDigest: null })],
      catalogSkills: [],
      installedSkills: [],
    });

    expect(result.verdict).toBe('failure');
    expect(result.details.join('\n')).toContain('no manifest');
  });

  it('reports a runtime-only skill without calling it drift', () => {
    // The operator's host skills live only in the runtime. The repository
    // is not obliged to carry them, so this is information, not failure.
    const repoSkills = [fact('halt-aware-destructive-ops')];
    const result = checkSkillCatalog({
      repoSkills,
      catalogSkills: [...repoSkills, fact('vault-pat-verify')],
      installedSkills: [...repoSkills, fact('vault-pat-verify')],
    });

    expect(result.verdict).toBe('success');
    expect(result.details.join('\n')).toContain('vault-pat-verify');
    expect(result.details.join('\n')).toContain('living only in the runtime');
  });

  it('says unknown when the repository skills directory could not be read', () => {
    const result = checkSkillCatalog({
      repoSkills: [],
      catalogSkills: [],
      installedSkills: [],
    });

    expect(result.verdict).toBe('unknown');
  });
});

describe('runtime audit · skill facts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'memphis-skill-fact-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('measures the document bytes and the manifest content', async () => {
    await mkdir(path.join(dir, 'demo'), { recursive: true });
    await writeFile(path.join(dir, 'demo', 'SKILL.md'), '# demo\n', 'utf8');
    await writeFile(
      path.join(dir, 'demo', 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, id: 'demo', tags: ['b', 'a'] }),
      'utf8',
    );

    const measured = await readSkillFact(path.join(dir, 'demo'), 'demo');
    expect(measured.skillMdDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(measured.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(measured.manifestUnreadable).toBe(false);
  });

  it('treats a reformatted manifest as the same manifest', async () => {
    // The installer rewrites the manifest through `normalizeSkillManifest`,
    // which sorts the tags. A byte comparison would call that drift; the
    // manifest is compared by what it SAYS.
    await mkdir(path.join(dir, 'a'), { recursive: true });
    await mkdir(path.join(dir, 'b'), { recursive: true });
    await writeFile(path.join(dir, 'a', 'SKILL.md'), 'x', 'utf8');
    await writeFile(path.join(dir, 'b', 'SKILL.md'), 'x', 'utf8');
    await writeFile(
      path.join(dir, 'a', 'manifest.json'),
      JSON.stringify({ id: 'demo', tags: ['b', 'a'] }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'b', 'manifest.json'),
      JSON.stringify({ tags: ['b', 'a'], id: 'demo' }, null, 2),
      'utf8',
    );

    const first = await readSkillFact(path.join(dir, 'a'), 'demo');
    const second = await readSkillFact(path.join(dir, 'b'), 'demo');
    expect(first.manifestDigest).toBe(second.manifestDigest);
  });

  it('reports an unreadable manifest instead of pretending it matches', async () => {
    await mkdir(path.join(dir, 'broken'), { recursive: true });
    await writeFile(path.join(dir, 'broken', 'SKILL.md'), 'x', 'utf8');
    await writeFile(path.join(dir, 'broken', 'manifest.json'), '{not json', 'utf8');

    const measured = await readSkillFact(path.join(dir, 'broken'), 'broken');
    expect(measured.manifestDigest).toBeNull();
    expect(measured.manifestUnreadable).toBe(true);
  });
});
