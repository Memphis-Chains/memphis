import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SkillManifestRef,
  SkillMaterializationResult,
  SkillManifestSource,
} from './catalog.js';
import { getSkillsPath } from '../../config/paths.js';

export type SkillRegistryRecord = {
  id: string;
  name: string;
  description: string;
  source: SkillManifestSource;
  tags: string[];
  tools: string[];
  installed: boolean;
  catalogPath: string;
  installedPath: string;
  installedAt: string;
  updatedAt: string;
};

type SkillRegistry = {
  schemaVersion: 1;
  skills: SkillRegistryRecord[];
};

const DEFAULT_REGISTRY: SkillRegistry = {
  schemaVersion: 1,
  skills: [],
};

function registryPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getSkillsPath(rawEnv), 'registry.json');
}

export function loadSkillRegistry(rawEnv: NodeJS.ProcessEnv = process.env): SkillRegistry {
  const path = registryPath(rawEnv);
  if (!existsSync(path)) return { ...DEFAULT_REGISTRY, skills: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkillRegistry>;
    return {
      schemaVersion: 1,
      skills: Array.isArray(parsed.skills) ? (parsed.skills as SkillRegistryRecord[]) : [],
    };
  } catch {
    return { ...DEFAULT_REGISTRY, skills: [] };
  }
}

export function saveSkillRegistry(
  registry: SkillRegistry,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const path = registryPath(rawEnv);
  mkdirSync(getSkillsPath(rawEnv), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2), 'utf8');
}

export function listSkillRegistryRecords(
  rawEnv: NodeJS.ProcessEnv = process.env,
): SkillRegistryRecord[] {
  return loadSkillRegistry(rawEnv).skills;
}

export function getSkillRegistryRecord(
  id: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SkillRegistryRecord | undefined {
  return loadSkillRegistry(rawEnv).skills.find((skill) => skill.id === id);
}

export function recordInstalledSkill(
  ref: SkillManifestRef,
  result: SkillMaterializationResult,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SkillRegistryRecord {
  const registry = loadSkillRegistry(rawEnv);
  const now = new Date().toISOString();
  const existing = registry.skills.find((skill) => skill.id === ref.manifest.id);

  const record: SkillRegistryRecord = {
    id: ref.manifest.id,
    name: ref.manifest.name,
    description: ref.manifest.description,
    source: result.ref.source,
    tags: ref.manifest.tags,
    tools: ref.manifest.tools,
    installed: true,
    catalogPath: result.catalogPath,
    installedPath: result.installedPath,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };

  registry.skills = [record, ...registry.skills.filter((skill) => skill.id !== record.id)].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  saveSkillRegistry(registry, rawEnv);
  return record;
}
