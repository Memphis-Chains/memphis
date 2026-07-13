import {
  runMemphisSkillCreate,
  runMemphisSkillInstall,
  runMemphisSkillList,
  runMemphisSkillShow,
  runMemphisSkillValidate,
} from '../../../mcp/tools/skill.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  optionalBoolean,
  optionalString,
  optionalStringArray,
  requiredString,
} from '../input-normalization.js';

export function createSkillRuntimeTools(rawEnv?: NodeJS.ProcessEnv): RuntimeToolDefinition[] {
  return [
    // ─── Skill management (2026-05-12) ──────────────────────────────────
    // First-class tools for Memphis-side skill composition / install.
    // Replaces the prior pattern of memphis_fs_write + memphis_exec which
    // gave Memphis no schema feedback when a manifest field was wrong.
    buildTool({
      name: 'memphis_skill_list',
      description:
        'List Memphis skills (built-in + local catalog + installed). Filter by installed/draft.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'installed', 'draft'],
            description:
              "'installed' = ready-to-run; 'draft' = catalogued but not installed; 'all' = both",
          },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        const raw = (args as { filter?: unknown }).filter;
        const filter: 'installed' | 'draft' | 'all' | undefined =
          raw === 'installed' || raw === 'draft' || raw === 'all' ? raw : undefined;
        return { filter };
      },
      execute(input) {
        return runMemphisSkillList(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_show',
      description:
        'Show full skill manifest (description, tools, workflow, prompt hints, examples, notes) for one skill, either by id or by direct file path.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id from memphis_skill_list' },
          file: { type: 'string', description: 'Path to a manifest.json (overrides id)' },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          id: optionalString(args, 'id'),
          file: optionalString(args, 'file'),
        };
      },
      execute(input) {
        return runMemphisSkillShow(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_create',
      description:
        'Scaffold a draft skill manifest with placeholder workflow + hints. Writes manifest.json + SKILL.md under ~/.memphis/skills/drafts/<id>/ (or custom --out). Memphis edits the placeholders, then runs memphis_skill_validate, then memphis_skill_install.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (kebab-case, e.g. daily-brief)' },
          name: { type: 'string', description: 'Human-readable name (default: derived from id)' },
          description: { type: 'string', description: 'One-line description' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools the skill will use (must be valid TOOL_REGISTRY entries)',
          },
          out: { type: 'string', description: 'Custom output directory (default: drafts dir)' },
          force: { type: 'boolean', description: 'Overwrite existing draft if present' },
        },
        required: ['id'],
      },
      isReadOnly: false,
      validateInput(args) {
        return {
          id: requiredString(args, 'id'),
          name: optionalString(args, 'name'),
          description: optionalString(args, 'description'),
          tools: optionalStringArray(args, 'tools'),
          out: optionalString(args, 'out'),
          force: optionalBoolean(args, 'force'),
        };
      },
      execute(input) {
        return runMemphisSkillCreate(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_validate',
      description:
        'Validate a skill manifest before install: schema shape + every declared tool must exist in TOOL_REGISTRY. Returns structured ok/error + suggestedFix hint when applicable. Idempotent, safe to call repeatedly.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (validates draft from catalog)' },
          file: { type: 'string', description: 'Path to manifest.json (overrides id)' },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          id: optionalString(args, 'id'),
          file: optionalString(args, 'file'),
        };
      },
      execute(input) {
        return runMemphisSkillValidate(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_skill_install',
      description:
        'Promote a draft skill to catalog + installed dirs and record in the skills registry. Runs validation first; refuses on schema or unknown-tool errors. After install the skill is visible to cognitive frames and cron triggers.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (from drafts or catalog)' },
          file: { type: 'string', description: 'Path to manifest.json (overrides id)' },
          force: { type: 'boolean', description: 'Overwrite existing installed skill if present' },
        },
      },
      isReadOnly: false,
      validateInput(args) {
        return {
          id: optionalString(args, 'id'),
          file: optionalString(args, 'file'),
          force: optionalBoolean(args, 'force'),
        };
      },
      execute(input) {
        return runMemphisSkillInstall(input, rawEnv);
      },
    }),
  ];
}
