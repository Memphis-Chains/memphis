/**
 * Unit tests for memphis_skill_* first-class tools (2026-05-12).
 *
 * Covers: list filtering, scaffold + validate roundtrip, install flow,
 * suggestedFix on unknown-tool error. Mirrors the per-tool contract
 * documented in TOOL_REGISTRY so the surface stays consistent with
 * `memphis skills` CLI handler.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runMemphisSkillCreate,
  runMemphisSkillInstall,
  runMemphisSkillList,
  runMemphisSkillShow,
  runMemphisSkillValidate,
} from '../../src/mcp/tools/skill.js';

describe('memphis_skill_* first-class tools', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memphis-skill-tools-'));
    env = {
      ...process.env,
      MEMPHIS_HOME: tmpDir,
      MEMPHIS_DATA_DIR: join(tmpDir, 'data'),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists built-in skills with installed=false on fresh install', () => {
    const result = runMemphisSkillList({ filter: 'all' }, env);
    expect(result.skills.length).toBeGreaterThan(0);
    expect(result.skills.every((s) => !s.installed)).toBe(true);
    expect(result.skills.every((s) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
  });

  it('filter=draft hides installed, filter=installed hides drafts', () => {
    const all = runMemphisSkillList({ filter: 'all' }, env);
    const drafts = runMemphisSkillList({ filter: 'draft' }, env);
    const installed = runMemphisSkillList({ filter: 'installed' }, env);
    expect(drafts.skills.every((s) => !s.installed)).toBe(true);
    expect(installed.skills.every((s) => s.installed)).toBe(true);
    expect(drafts.skills.length + installed.skills.length).toBe(all.skills.length);
  });

  it('create scaffolds a draft with manifest + SKILL.md', () => {
    const result = runMemphisSkillCreate(
      {
        id: 'test-skill-create',
        name: 'Test Skill',
        description: 'A test skill for unit tests',
        tools: ['memphis_journal', 'memphis_health'],
      },
      env,
    );
    expect(result.ok).toBe(true);
    expect(result.id).toBe('test-skill-create');
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(existsSync(result.skillMarkdownPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8')) as {
      id: string;
      name: string;
      tools: string[];
    };
    expect(manifest.id).toBe('test-skill-create');
    expect(manifest.name).toBe('Test Skill');
    // Tools sorted alphabetically by manifest normalizer.
    expect(manifest.tools).toEqual(['memphis_health', 'memphis_journal']);
  });

  it('validate detects unknown tools with suggestedFix hint', () => {
    const created = runMemphisSkillCreate(
      {
        id: 'test-skill-bad-tools',
        name: 'Test Skill Bad Tools',
        tools: ['memphis_journal', 'memphis_NONEXISTENT_TOOL'],
      },
      env,
    );
    const result = runMemphisSkillValidate({ file: created.manifestPath }, env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toMatch(/unknown tool/i);
      expect(result.suggestedFix).toMatch(/memphis_self_describe|TOOL_REGISTRY/i);
    }
  });

  it('validate passes for a clean manifest', () => {
    const created = runMemphisSkillCreate(
      {
        id: 'test-skill-good',
        name: 'Good Skill',
        tools: ['memphis_journal'],
      },
      env,
    );
    const result = runMemphisSkillValidate({ file: created.manifestPath }, env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe('test-skill-good');
      expect(result.tools).toEqual(['memphis_journal']);
    }
  });

  it('install promotes draft to catalog + installed dirs', () => {
    const created = runMemphisSkillCreate(
      {
        id: 'test-skill-install',
        name: 'Installable',
        tools: ['memphis_journal'],
      },
      env,
    );
    const result = runMemphisSkillInstall({ file: created.manifestPath }, env);
    expect(result.ok).toBe(true);
    expect(result.id).toBe('test-skill-install');
    expect(existsSync(result.catalogPath)).toBe(true);
    expect(existsSync(result.installedPath)).toBe(true);
    expect(existsSync(join(result.installedPath, 'manifest.json'))).toBe(true);
    expect(existsSync(join(result.installedPath, 'SKILL.md'))).toBe(true);

    const list = runMemphisSkillList({ filter: 'installed' }, env);
    expect(list.skills.find((s) => s.id === 'test-skill-install')?.installed).toBe(true);
  });

  it('install refuses on unknown tool (validation before install)', () => {
    const created = runMemphisSkillCreate(
      {
        id: 'test-skill-install-bad',
        tools: ['memphis_NONEXISTENT'],
      },
      env,
    );
    expect(() => runMemphisSkillInstall({ file: created.manifestPath }, env)).toThrow(
      /unknown tool/i,
    );
  });

  it('show returns full manifest after install', () => {
    const created = runMemphisSkillCreate(
      { id: 'test-skill-show', tools: ['memphis_journal'] },
      env,
    );
    runMemphisSkillInstall({ file: created.manifestPath }, env);
    const detail = runMemphisSkillShow({ id: 'test-skill-show' }, env);
    expect(detail.id).toBe('test-skill-show');
    expect(detail.tools).toContain('memphis_journal');
    expect(detail.workflow.length).toBeGreaterThan(0);
    expect(detail.installed).toBe(true);
  });

  it('show via file argument works without install', () => {
    const created = runMemphisSkillCreate(
      { id: 'test-skill-show-by-file', tools: ['memphis_journal'] },
      env,
    );
    const detail = runMemphisSkillShow({ file: created.manifestPath }, env);
    expect(detail.id).toBe('test-skill-show-by-file');
  });
});
