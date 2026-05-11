/**
 * First-class skill tools — Memphis can compose, validate, install, list,
 * and inspect its own skills via structured tool calls instead of shelling
 * out via `memphis_exec memphis skills <subcommand>`. Closes the
 * skill-creation friction observed 2026-05-11 (Memphis composed manifests
 * by file-writes + exec'd CLI; schema mistakes went unguided, fake tool
 * names slipped through anti-confab as code-fence calls).
 *
 * Each tool wraps an existing function from `src/modules/skills/*` so the
 * surface stays consistent with the CLI handler — same validation, same
 * storage layout, same registry semantics.
 */
import {
  createSkillScaffold,
  getSkillManifest,
  importSkillManifestFile,
  inspectSkillCatalog,
  materializeInstalledSkill,
  validateSkillManifestFile,
  type SkillManifestRef,
} from '../../modules/skills/catalog.js';
import { recordInstalledSkill } from '../../modules/skills/registry.js';
import { listInstalledSkillSummaries } from '../../modules/skills/runtime.js';

export interface MemphisSkillListInput {
  filter?: 'all' | 'installed' | 'draft';
}

export interface MemphisSkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  installed: boolean;
  installedPath?: string;
  source: { kind: string; path?: string };
}

export function runMemphisSkillList(
  input: MemphisSkillListInput = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): { skills: MemphisSkillSummary[] } {
  const catalog = inspectSkillCatalog(rawEnv);
  const installed = new Set(listInstalledSkillSummaries(rawEnv).map((s) => s.id));
  const filter = input.filter ?? 'all';

  const out: MemphisSkillSummary[] = catalog.manifests
    .map((ref) => {
      const isInstalled = installed.has(ref.manifest.id);
      const summary: MemphisSkillSummary = {
        id: ref.manifest.id,
        name: ref.manifest.name,
        description: ref.manifest.description,
        tags: ref.manifest.tags,
        tools: ref.manifest.tools,
        installed: isInstalled,
        source: ref.source,
      };
      if (isInstalled) {
        const found = listInstalledSkillSummaries(rawEnv).find((s) => s.id === ref.manifest.id);
        if (found?.installedPath) summary.installedPath = found.installedPath;
      }
      return summary;
    })
    .filter((s) => {
      if (filter === 'installed') return s.installed;
      if (filter === 'draft') return !s.installed;
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return { skills: out };
}

export interface MemphisSkillShowInput {
  id?: string;
  file?: string;
}

export interface MemphisSkillDetail {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  workflow: string[];
  promptHints: string[];
  examples: Array<{ prompt: string; outcome: string }>;
  notes: string[];
  source: { kind: string; path?: string };
  installed: boolean;
}

export function runMemphisSkillShow(
  input: MemphisSkillShowInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSkillDetail {
  const ref = getSkillManifest({ id: input.id, file: input.file, rawEnv });
  const installed = listInstalledSkillSummaries(rawEnv).some((s) => s.id === ref.manifest.id);
  return {
    id: ref.manifest.id,
    name: ref.manifest.name,
    description: ref.manifest.description,
    tags: ref.manifest.tags,
    tools: ref.manifest.tools,
    workflow: ref.manifest.workflow,
    promptHints: ref.manifest.promptHints,
    examples: ref.manifest.examples,
    notes: ref.manifest.notes,
    source: ref.source,
    installed,
  };
}

export interface MemphisSkillCreateInput {
  id: string;
  name?: string;
  description?: string;
  tools?: string[];
  out?: string;
  force?: boolean;
}

export interface MemphisSkillCreateOutput {
  ok: true;
  id: string;
  draftDir: string;
  manifestPath: string;
  skillMarkdownPath: string;
  message: string;
}

export function runMemphisSkillCreate(
  input: MemphisSkillCreateInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSkillCreateOutput {
  const result = createSkillScaffold({
    id: input.id,
    name: input.name,
    description: input.description,
    tools: input.tools?.join(','),
    out: input.out,
    force: input.force,
    rawEnv,
  });
  return {
    ok: true,
    id: result.ref.manifest.id,
    draftDir: result.outputDir,
    manifestPath: result.manifestPath,
    skillMarkdownPath: result.skillPath,
    message:
      `Draft scaffolded at ${result.outputDir}. Edit manifest.json + SKILL.md, then run ` +
      `memphis_skill_validate to check it, then memphis_skill_install to materialize ` +
      `into the catalog and installed dirs.`,
  };
}

export interface MemphisSkillValidateInput {
  id?: string;
  file?: string;
}

export type MemphisSkillValidateOutput =
  | {
      ok: true;
      id: string;
      manifestPath: string;
      tools: string[];
      message: string;
    }
  | {
      ok: false;
      path: string;
      detail: string;
      suggestedFix?: string;
    };

export function runMemphisSkillValidate(
  input: MemphisSkillValidateInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSkillValidateOutput {
  // Resolve the manifest path. Either explicit file= or look up id in
  // catalog (catalog covers drafts too via the local catalog scanner).
  let manifestPath: string;
  if (input.file) {
    manifestPath = input.file;
  } else if (input.id) {
    const ref = getSkillManifest({ id: input.id, rawEnv });
    if (!ref.source.path) {
      return {
        ok: false,
        path: `id:${input.id}`,
        detail: `skill ${input.id} has no on-disk manifest (built-in only)`,
      };
    }
    manifestPath = ref.source.path;
  } else {
    return {
      ok: false,
      path: '(none)',
      detail: 'memphis_skill_validate requires either id or file argument',
    };
  }

  const result = validateSkillManifestFile(manifestPath);
  if (result.ok) {
    return {
      ok: true,
      id: result.ref.manifest.id,
      manifestPath,
      tools: result.ref.manifest.tools,
      message: `Manifest valid (${result.ref.manifest.tools.length} tools declared, ${result.ref.manifest.workflow.length} workflow steps). Safe to install.`,
    };
  }

  // Add an actionable fix hint when we can guess what the issue is.
  let suggestedFix: string | undefined;
  if (/unknown tool/i.test(result.detail)) {
    suggestedFix =
      'Tool name(s) must exist in TOOL_REGISTRY. Use memphis_self_describe to list available tools; common typos: memphis_voice_speak (not memphis_TTS_*), memphis_web_fetch (not memphis_http_*).';
  } else if (/schema/i.test(result.detail) || /required/i.test(result.detail)) {
    suggestedFix =
      'Manifest schema requires: schemaVersion (1), id, name, description, tags[], tools[], workflow[], promptHints[], examples[]. Run memphis_skill_create with placeholders, then edit fields you need.';
  }

  return {
    ok: false,
    path: result.path,
    detail: result.detail,
    suggestedFix,
  };
}

export interface MemphisSkillInstallInput {
  id?: string;
  file?: string;
  force?: boolean;
}

export interface MemphisSkillInstallOutput {
  ok: true;
  id: string;
  catalogPath: string;
  installedPath: string;
  manifestPath: string;
  message: string;
}

export function runMemphisSkillInstall(
  input: MemphisSkillInstallInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSkillInstallOutput {
  // Resolve to a manifest file path. The install path always goes through
  // importSkillManifestFile so the file→catalog promotion is reused and
  // validation runs before any write.
  let manifestPath: string;
  if (input.file) {
    manifestPath = input.file;
  } else if (input.id) {
    const ref = getSkillManifest({ id: input.id, rawEnv });
    if (!ref.source.path) {
      throw new Error(
        `Skill ${input.id} has no on-disk manifest to install. ` +
          `Built-in skills are activated via memphis_skill_install with file=<path>.`,
      );
    }
    manifestPath = ref.source.path;
  } else {
    throw new Error('memphis_skill_install requires either id or file argument');
  }

  const imported = importSkillManifestFile(manifestPath, {
    force: input.force,
    rawEnv,
  });
  const ref: SkillManifestRef = imported.ref;
  const materialized = materializeInstalledSkill(ref, { force: input.force, rawEnv });
  recordInstalledSkill(ref, materialized, rawEnv);
  return {
    ok: true,
    id: materialized.ref.manifest.id,
    catalogPath: materialized.catalogPath,
    installedPath: materialized.installedPath,
    manifestPath: materialized.manifestPath,
    message:
      `Skill '${materialized.ref.manifest.id}' installed. SKILL.md + manifest.json materialized at ` +
      `catalog (${materialized.catalogPath}) and installed (${materialized.installedPath}). ` +
      `Registry updated; surface as available to cognitive frames + cron triggers.`,
  };
}
