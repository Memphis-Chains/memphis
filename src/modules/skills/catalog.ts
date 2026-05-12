import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { getSkillsPath } from '../../config/paths.js';
import { AppError } from '../../core/errors.js';
import { TOOL_REGISTRY } from '../../gateway/tool-registry.js';

export type SkillManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  workflow: string[];
  promptHints: string[];
  examples: Array<{
    prompt: string;
    outcome: string;
  }>;
  notes: string[];
};

export type SkillManifestSource = {
  kind: 'builtin' | 'file';
  path?: string;
};

export type SkillManifestRef = {
  manifest: SkillManifest;
  source: SkillManifestSource;
};

export type SkillCatalogError = {
  path: string;
  detail: string;
};

export type SkillCatalogInspection = {
  catalogDir: string;
  installedDir: string;
  draftsDir: string;
  manifests: SkillManifestRef[];
  errors: SkillCatalogError[];
};

export type SkillValidationResult =
  | { ok: true; ref: SkillManifestRef }
  | { ok: false; path: string; detail: string };

export type SkillImportResult = {
  ok: true;
  ref: SkillManifestRef;
  manifestPath: string;
  skillPath: string;
};

export type SkillMaterializationResult = {
  ok: true;
  ref: SkillManifestRef;
  catalogPath: string;
  installedPath: string;
  manifestPath: string;
  skillPath: string;
};

export type SkillScaffoldResult = {
  ok: true;
  ref: SkillManifestRef;
  outputDir: string;
  manifestPath: string;
  skillPath: string;
};

const MANIFEST_FILENAME = 'manifest.json';
const SKILL_FILENAME = 'SKILL.md';

const skillExampleSchema = z.object({
  prompt: z.string().trim().min(1),
  outcome: z.string().trim().min(1),
});

const skillManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
  workflow: z.array(z.string().trim().min(1)).optional(),
  promptHints: z.array(z.string().trim().min(1)).optional(),
  examples: z.array(skillExampleSchema).optional(),
  notes: z.array(z.string().trim().min(1)).optional(),
});

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeSkillManifest(input: unknown): SkillManifest {
  const parsed = skillManifestSchema.parse(input);
  return {
    schemaVersion: 1,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    tags: uniqueSorted(parsed.tags ?? []),
    tools: uniqueSorted(parsed.tools ?? []),
    workflow: [...(parsed.workflow ?? [])],
    promptHints: [...(parsed.promptHints ?? [])],
    examples: [...(parsed.examples ?? [])],
    notes: [...(parsed.notes ?? [])],
  };
}

function builtinSkill(manifest: SkillManifest): SkillManifestRef {
  return {
    manifest,
    source: { kind: 'builtin' },
  };
}

const BUILTIN_MANIFESTS: SkillManifestRef[] = [
  builtinSkill(
    normalizeSkillManifest({
      schemaVersion: 1,
      id: 'deploy-troubleshooter',
      name: 'Deploy Troubleshooter',
      description:
        'Diagnose Memphis deploy failures with health checks, targeted tests, and explicit rollback thresholds.',
      tags: ['deploy', 'health', 'rollback'],
      tools: ['memphis_deploy', 'memphis_health', 'memphis_search', 'memphis_test'],
      workflow: [
        'Start with deploy or runtime health signals before escalating into broader debugging.',
        'Use targeted test suites and exact search to isolate the failing surface.',
        'When post-deploy health degrades, state the rollback threshold explicitly before acting.',
      ],
      promptHints: [
        'Prefer deploy pipeline primitives over ad hoc shell commands.',
        'Summarize root cause, mitigation, and verification evidence in one pass.',
      ],
      examples: [
        {
          prompt:
            'Investigate why the latest Memphis deploy passed build but failed health checks.',
          outcome:
            'The skill drives deploy health, targeted tests, exact search, and rollback criteria before recommending or executing a fix.',
        },
      ],
      notes: [
        'Best fit for post-deploy regressions, CI preflight failures, and runtime health incidents.',
      ],
    }),
  ),
  builtinSkill(
    normalizeSkillManifest({
      schemaVersion: 1,
      id: 'memory-curator',
      name: 'Memory Curator',
      description:
        'Use chain query, recall, search, and journaling deliberately so durable memory stays compact and useful.',
      tags: ['chains', 'memory', 'recall'],
      tools: ['memphis_chain_query', 'memphis_journal', 'memphis_recall', 'memphis_search'],
      workflow: [
        'Search semantically and exactly before deciding memory already exists.',
        'Inspect raw chain truth when recall/search disagree with operator expectations.',
        'Journal only durable takeaways, not transient output.',
      ],
      promptHints: [
        'Prefer precise tags and minimal durable summaries.',
        'Treat journal writes as permanent operator memory, not scratch space.',
      ],
      examples: [
        {
          prompt:
            'Find whether we already recorded a vault rotation plan and write only the missing durable takeaway.',
          outcome:
            'The skill checks recall and exact search first, audits the raw chain if needed, then writes only the new durable fact.',
        },
      ],
      notes: ['Useful when memory quality matters more than speed.'],
    }),
  ),
  builtinSkill(
    normalizeSkillManifest({
      schemaVersion: 1,
      id: 'self-mod-operator',
      name: 'Self-Mod Operator',
      description:
        'Run a disciplined Memphis self-modification loop: inspect narrowly, change minimally, validate hard, and summarize clearly.',
      tags: ['coding', 'self-modification', 'tests'],
      tools: [
        'memphis_code_read',
        'memphis_git',
        'memphis_glob',
        'memphis_grep',
        'memphis_self_modify',
        'memphis_test',
      ],
      workflow: [
        'Inspect the current codepath before proposing edits.',
        'Keep the change set narrow and test only the affected surface first, then broaden as needed.',
        'Report what changed, what was verified, and any remaining risk before handing off.',
      ],
      promptHints: [
        'Prefer grep/glob/code-read before execution.',
        'Treat tests and lint as release gates, not optional cleanup.',
      ],
      examples: [
        {
          prompt:
            'Fix a Memphis regression without widening the blast radius or hiding untested risk.',
          outcome:
            'The skill steers the agent through narrow inspection, minimal change, targeted validation, and explicit risk reporting.',
        },
      ],
      notes: [
        'Best fit for code changes, refactors, and regression fixes inside the Memphis repo.',
      ],
    }),
  ),
  builtinSkill(
    normalizeSkillManifest({
      schemaVersion: 1,
      id: 'kartograf-zone-router',
      name: 'Kartograf Zone Router',
      description:
        'Use Kartograf inference to pick the right Memphis chain before writing. Surface the top zones and corroborate with recall when stakes are high.',
      tags: ['kartograf', 'routing', 'memory', 'chains'],
      tools: ['memphis_kartograf', 'memphis_recall', 'memphis_journal'],
      workflow: [
        'Call memphis_kartograf with the text you intend to remember.',
        'Inspect the top zones — if score(top) > 0.7 take it as the destination chain, else short-list top 3 and corroborate via memphis_recall on each candidate chain.',
        'Write to the chosen chain via memphis_journal (or chain-specific tool). Cite the kartograf checkpointId + top zone score in the audit trail so future readers can trace the routing decision.',
      ],
      promptHints: [
        'Kartograf v1 has recall@10 = 0.27 — treat the top zone as a HINT, not a hard route.',
        'When the top two zones are within 0.2 of each other, prefer corroboration over the model alone.',
        'If memphis_kartograf returns stateKind=disabled, fall back to memphis_recall + the chain catalog before writing — do NOT proceed silently with the default chain.',
      ],
      examples: [
        {
          prompt:
            'I have a decision about migrating from Anthropic to MiniMax — which chain should this go in?',
          outcome:
            'Skill calls memphis_kartograf, gets zones (likely top=decisions), confirms via memphis_recall against the decisions chain, then writes to decisions with the model-provided routing hint cited.',
        },
      ],
      notes: [
        'Requires MEMPHIS_KARTOGRAF_ENABLE=1 and an installed checkpoint. If neither is true the tool returns stateKind=disabled / no-checkpoint and the skill bails to manual routing.',
        'The kartograf model is small (DeBERTa-v3-base, 12-class classifier). It will mis-classify edge cases — corroboration is non-optional for important writes.',
      ],
    }),
  ),
] as const;

function catalogDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getSkillsPath(rawEnv), 'catalog');
}

function installedDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getSkillsPath(rawEnv), 'installed');
}

function draftsDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getSkillsPath(rawEnv), 'drafts');
}

function manifestPathForSkillDir(skillDir: string): string {
  return join(skillDir, MANIFEST_FILENAME);
}

function skillMarkdownPathForDir(skillDir: string): string {
  return join(skillDir, SKILL_FILENAME);
}

function loadSkillManifestFromPath(pathValue: string): SkillManifestRef {
  const resolved = resolve(pathValue);
  return {
    manifest: normalizeSkillManifest(JSON.parse(readFileSync(resolved, 'utf8')) as unknown),
    source: { kind: 'file', path: resolved },
  };
}

function writeSkillPackage(skillDir: string, manifest: SkillManifest, markdown: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(manifestPathForSkillDir(skillDir), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(skillMarkdownPathForDir(skillDir), markdown, 'utf8');
}

function ensureWritableSkillDir(skillDir: string, force = false): void {
  if (!existsSync(skillDir)) return;
  const entries = readdirSync(skillDir);
  if (!force && entries.length > 0) {
    throw new AppError('VALIDATION_ERROR', `skill destination already exists: ${skillDir}`, 409, {
      skillDir,
    });
  }
}

function titleCaseId(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function defaultTagsForId(id: string): string[] {
  return uniqueSorted(id.split('-').slice(0, 3));
}

function parseToolCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return uniqueSorted(raw.split(','));
}

function resolveSkillMarkdownForRef(ref: SkillManifestRef): string {
  if (ref.source.path) {
    const sourceMarkdownPath = skillMarkdownPathForDir(dirname(ref.source.path));
    if (existsSync(sourceMarkdownPath)) {
      return readFileSync(sourceMarkdownPath, 'utf8');
    }
  }
  return renderSkillMarkdown(ref.manifest);
}

function loadLocalCatalogManifests(rawEnv: NodeJS.ProcessEnv = process.env): {
  manifests: SkillManifestRef[];
  errors: SkillCatalogError[];
} {
  const dir = catalogDir(rawEnv);
  if (!existsSync(dir)) {
    return { manifests: [], errors: [] };
  }

  const manifests: SkillManifestRef[] = [];
  const errors: SkillCatalogError[] = [];

  for (const entry of readdirSync(dir).sort((left, right) => left.localeCompare(right))) {
    const skillDir = join(dir, entry);
    const pathValue = manifestPathForSkillDir(skillDir);
    if (!existsSync(pathValue)) {
      errors.push({ path: skillDir, detail: `${MANIFEST_FILENAME} missing` });
      continue;
    }

    try {
      manifests.push(loadSkillManifestFromPath(pathValue));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown skill manifest parse error';
      errors.push({ path: pathValue, detail });
    }
  }

  return { manifests, errors };
}

export function inspectSkillCatalog(
  rawEnv: NodeJS.ProcessEnv = process.env,
): SkillCatalogInspection {
  const merged = new Map<string, SkillManifestRef>();
  const local = loadLocalCatalogManifests(rawEnv);

  for (const ref of BUILTIN_MANIFESTS) {
    merged.set(ref.manifest.id, ref);
  }
  for (const ref of local.manifests) {
    merged.set(ref.manifest.id, ref);
  }

  return {
    catalogDir: catalogDir(rawEnv),
    installedDir: installedDir(rawEnv),
    draftsDir: draftsDir(rawEnv),
    manifests: [...merged.values()].sort((left, right) =>
      left.manifest.id.localeCompare(right.manifest.id),
    ),
    errors: local.errors,
  };
}

export function getSkillManifest(input: {
  id?: string;
  file?: string;
  rawEnv?: NodeJS.ProcessEnv;
}): SkillManifestRef {
  if (input.file) {
    return loadSkillManifestFromPath(input.file);
  }

  const id = input.id?.trim();
  if (!id) {
    throw new AppError('VALIDATION_ERROR', 'skill requires an id or --file manifest path', 400);
  }

  const hit = inspectSkillCatalog(input.rawEnv).manifests.find((ref) => ref.manifest.id === id);
  if (!hit) {
    throw new AppError('VALIDATION_ERROR', `skill manifest not found: ${id}`, 404, {
      id,
      available: inspectSkillCatalog(input.rawEnv).manifests.map((ref) => ref.manifest.id),
    });
  }
  return hit;
}

export function describeSkillManifest(ref: SkillManifestRef): {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  workflowCount: number;
  promptHintCount: number;
  exampleCount: number;
  source: SkillManifestSource;
} {
  return {
    id: ref.manifest.id,
    name: ref.manifest.name,
    description: ref.manifest.description,
    tags: ref.manifest.tags,
    tools: ref.manifest.tools,
    workflowCount: ref.manifest.workflow.length,
    promptHintCount: ref.manifest.promptHints.length,
    exampleCount: ref.manifest.examples.length,
    source: ref.source,
  };
}

export function renderSkillMarkdown(manifest: SkillManifest): string {
  const lines: string[] = [`# ${manifest.name}`, '', manifest.description, ''];

  lines.push('## Identity');
  lines.push(`- id: ${manifest.id}`);
  lines.push(`- tags: ${manifest.tags.length > 0 ? manifest.tags.join(', ') : 'none'}`);
  lines.push(`- tools: ${manifest.tools.length > 0 ? manifest.tools.join(', ') : 'none declared'}`);
  lines.push('');

  if (manifest.workflow.length > 0) {
    lines.push('## Workflow');
    manifest.workflow.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('');
  }

  if (manifest.promptHints.length > 0) {
    lines.push('## Prompt Hints');
    manifest.promptHints.forEach((hint) => lines.push(`- ${hint}`));
    lines.push('');
  }

  if (manifest.examples.length > 0) {
    lines.push('## Examples');
    manifest.examples.forEach((example, index) => {
      lines.push(`### Example ${index + 1}`);
      lines.push(`Prompt: ${example.prompt}`);
      lines.push(`Outcome: ${example.outcome}`);
      lines.push('');
    });
  }

  if (manifest.notes.length > 0) {
    lines.push('## Notes');
    manifest.notes.forEach((note) => lines.push(`- ${note}`));
    lines.push('');
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.join('\n');
}

export function validateSkillManifestFile(pathValue: string): SkillValidationResult {
  try {
    const ref = loadSkillManifestFromPath(pathValue);
    const unknownTools = ref.manifest.tools.filter((name) => !Object.hasOwn(TOOL_REGISTRY, name));
    if (unknownTools.length > 0) {
      return {
        ok: false,
        path: resolve(pathValue),
        detail: `unknown tool(s): ${unknownTools.join(', ')} — must be in TOOL_REGISTRY`,
      };
    }
    return { ok: true, ref };
  } catch (error) {
    return {
      ok: false,
      path: resolve(pathValue),
      detail: error instanceof Error ? error.message : 'unknown skill manifest validation error',
    };
  }
}

export function importSkillManifestFile(
  pathValue: string,
  options: { force?: boolean; rawEnv?: NodeJS.ProcessEnv } = {},
): SkillImportResult {
  const validation = validateSkillManifestFile(pathValue);
  if (!validation.ok) {
    throw new AppError('VALIDATION_ERROR', validation.detail, 400, { path: validation.path });
  }

  const ref = validation.ref;
  const destinationDir = join(catalogDir(options.rawEnv), ref.manifest.id);
  ensureWritableSkillDir(destinationDir, options.force);

  const markdown = resolveSkillMarkdownForRef(ref);
  writeSkillPackage(destinationDir, ref.manifest, markdown);

  if (ref.source.path) {
    const sourceMarkdownPath = skillMarkdownPathForDir(dirname(ref.source.path));
    if (existsSync(sourceMarkdownPath)) {
      copyFileSync(sourceMarkdownPath, skillMarkdownPathForDir(destinationDir));
    }
  }

  return {
    ok: true,
    ref: {
      manifest: ref.manifest,
      source: { kind: 'file', path: manifestPathForSkillDir(destinationDir) },
    },
    manifestPath: manifestPathForSkillDir(destinationDir),
    skillPath: skillMarkdownPathForDir(destinationDir),
  };
}

export function materializeInstalledSkill(
  ref: SkillManifestRef,
  options: { force?: boolean; rawEnv?: NodeJS.ProcessEnv } = {},
): SkillMaterializationResult {
  const resolvedRawEnv = options.rawEnv ?? process.env;
  const skillMarkdown = resolveSkillMarkdownForRef(ref);
  const resolvedCatalogDir = join(catalogDir(resolvedRawEnv), ref.manifest.id);
  const resolvedInstalledDir = join(installedDir(resolvedRawEnv), ref.manifest.id);

  if (options.force) {
    mkdirSync(resolvedCatalogDir, { recursive: true });
    mkdirSync(resolvedInstalledDir, { recursive: true });
  }

  writeSkillPackage(resolvedCatalogDir, ref.manifest, skillMarkdown);
  writeSkillPackage(resolvedInstalledDir, ref.manifest, skillMarkdown);

  return {
    ok: true,
    ref: {
      manifest: ref.manifest,
      source: { kind: 'file', path: manifestPathForSkillDir(resolvedCatalogDir) },
    },
    catalogPath: resolvedCatalogDir,
    installedPath: resolvedInstalledDir,
    manifestPath: manifestPathForSkillDir(resolvedInstalledDir),
    skillPath: skillMarkdownPathForDir(resolvedInstalledDir),
  };
}

export function createSkillScaffold(input: {
  id: string;
  name?: string;
  description?: string;
  tools?: string;
  out?: string;
  force?: boolean;
  rawEnv?: NodeJS.ProcessEnv;
}): SkillScaffoldResult {
  const id = input.id.trim();
  if (!id) {
    throw new AppError('VALIDATION_ERROR', 'skill scaffold requires an id', 400);
  }

  const manifest = normalizeSkillManifest({
    schemaVersion: 1,
    id,
    name: input.name?.trim() || titleCaseId(id),
    description: input.description?.trim() || `${titleCaseId(id)} skill package for Memphis.`,
    tags: defaultTagsForId(id),
    tools: parseToolCsv(input.tools),
    workflow: [
      'Confirm the skill matches the operator request before applying it.',
      'Use only the declared tools unless the operator explicitly broadens scope.',
      'Summarize what changed, what was verified, and what still needs operator attention.',
    ],
    promptHints: [
      'Restate the task in operational terms before executing.',
      'Prefer deterministic Memphis tools over improvised side paths.',
      'Keep the final handoff concise and evidence-backed.',
    ],
    examples: [
      {
        prompt: `Use ${titleCaseId(id)} to handle a concrete Memphis operator task.`,
        outcome:
          'The agent follows the declared workflow, uses the declared tools, and reports verification clearly.',
      },
    ],
    notes: [
      'Generated by `memphis skills create`.',
      'Edit manifest.json and SKILL.md before importing or publishing this skill.',
    ],
  });

  const outputDir = resolve(input.out ?? join(draftsDir(input.rawEnv), manifest.id));
  ensureWritableSkillDir(outputDir, input.force);
  writeSkillPackage(outputDir, manifest, renderSkillMarkdown(manifest));

  return {
    ok: true,
    ref: {
      manifest,
      source: { kind: 'file', path: manifestPathForSkillDir(outputDir) },
    },
    outputDir,
    manifestPath: manifestPathForSkillDir(outputDir),
    skillPath: skillMarkdownPathForDir(outputDir),
  };
}
