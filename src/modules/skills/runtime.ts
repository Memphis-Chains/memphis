import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SkillManifest } from './catalog.js';
import { inspectSkillCatalog } from './catalog.js';
import { listSkillRegistryRecords } from './registry.js';

export type InstalledSkillSummary = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  workflow: string[];
  installedPath: string;
};

function readInstalledManifest(pathValue: string): SkillManifest | undefined {
  if (!existsSync(pathValue)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(pathValue, 'utf8')) as SkillManifest;
  } catch {
    return undefined;
  }
}

export function listInstalledSkillSummaries(
  rawEnv: NodeJS.ProcessEnv = process.env,
): InstalledSkillSummary[] {
  const catalog = inspectSkillCatalog(rawEnv);
  const byId = new Map(catalog.manifests.map((ref) => [ref.manifest.id, ref.manifest]));

  return listSkillRegistryRecords(rawEnv)
    .map((record) => {
      const manifest =
        byId.get(record.id) ?? readInstalledManifest(join(record.installedPath, 'manifest.json'));

      if (!manifest) {
        return undefined;
      }

      return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        tags: manifest.tags,
        tools: manifest.tools,
        workflow: manifest.workflow,
        installedPath: record.installedPath,
      } satisfies InstalledSkillSummary;
    })
    .filter((value): value is InstalledSkillSummary => Boolean(value))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildInstalledSkillsPromptFragment(
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  const installed = listInstalledSkillSummaries(rawEnv);

  // Previously returned an empty string when no skills were installed,
  // which left the model to hallucinate about its "skills" from training
  // priors (e.g. "I can program in Rust, TypeScript, Python" or inventing
  // fictional `exacct`-style commands as capabilities). Observed on
  // operator WSL 2026-04-20 with qwen2.5-coder:3b.
  //
  // Emit a grounded "None installed" statement so the model has a fact
  // to cite when the operator asks about skills. The note below
  // explicitly forbids inventing capabilities beyond the tool list.
  if (installed.length === 0) {
    return `<installed_skills>
No operator skill packs are installed in this runtime. \`memphis skills list\` would return an empty catalog.

When the operator asks about your SKILLS or CAPABILITIES, say plainly that no skills are installed and point them to the <tools> block below for what you can actually do. Do NOT invent programming languages, CLI flags, or framework names as "skills" — the only grounded capabilities are the tools listed in <tools>.
</installed_skills>`;
  }

  const lines = installed
    .slice(0, 6)
    .flatMap((skill) => [
      `- ${skill.name} (${skill.id}): ${skill.description}`,
      `  tools: ${skill.tools.length > 0 ? skill.tools.join(', ') : 'none declared'}`,
      `  workflow: ${
        skill.workflow.length > 0 ? skill.workflow.slice(0, 2).join(' | ') : 'no workflow declared'
      }`,
    ]);

  return `<installed_skills>
Installed operator skill packs provide extra workflow guidance. When a skill clearly matches the task, follow it unless the operator asks for a different path. Do NOT invent additional skills beyond those listed here.
${lines.join('\n')}
</installed_skills>`;
}
