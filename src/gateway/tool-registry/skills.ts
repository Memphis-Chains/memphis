import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const SKILL_TOOLS: Record<string, ToolMeta> = {
  memphis_skill_list: {
    name: 'memphis_skill_list',
    tier: 1,
    capabilities: ['read'],
    description:
      'List Memphis skills (built-in + local catalog + installed). Filter by installed/draft/all (default all).',
    inputSchema: z
      .object({
        filter: z.enum(['all', 'installed', 'draft']).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Returns a compact list of skills Memphis can see — each entry has id, name, description, tags, declared tools, and an `installed` boolean. Use BEFORE composing a new skill so you do not duplicate an existing one (id collision blocks install). Use filter=installed to discover what is already wired into cron / cognitive frames.',
  },
  memphis_skill_show: {
    name: 'memphis_skill_show',
    tier: 1,
    capabilities: ['read'],
    description:
      'Show full skill manifest (workflow steps, prompt hints, examples, notes, declared tools) for one skill by id or file path.',
    inputSchema: z
      .object({
        id: z.string().optional(),
        file: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Use this to read a skill end-to-end before deciding whether to extend it, install it, or copy its shape into a new draft. Both `id` (from memphis_skill_list) and `file` (raw manifest.json path) are accepted — file overrides id.',
  },
  memphis_skill_create: {
    name: 'memphis_skill_create',
    tier: 2,
    capabilities: ['write'],
    description:
      'Scaffold a draft skill manifest with placeholder workflow + hints under ~/.memphis/skills/drafts/<id>/. Returns paths to edit. After editing, run memphis_skill_validate then memphis_skill_install.',
    inputSchema: z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        tools: z.array(z.string()).optional(),
        out: z.string().optional(),
        force: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Creates a fresh skill scaffold with placeholder text. ALWAYS prefer this over hand-writing manifest.json + SKILL.md via memphis_fs_write — the scaffold seeds the right schema shape, tag defaults, and a SKILL.md companion file Piper-friendly enough to render in TUI/Telegram. After scaffold, edit the placeholders (workflow array, promptHints, examples) via memphis_fs_write, then validate, then install. Tools list MUST be valid TOOL_REGISTRY entries — call memphis_self_describe to enumerate.',
  },
  memphis_skill_validate: {
    name: 'memphis_skill_validate',
    tier: 1,
    capabilities: ['read'],
    description:
      'Validate a skill manifest BEFORE install: schema shape + every declared tool must exist in TOOL_REGISTRY. Returns {ok, suggestedFix?} so you can iterate without leaving stale entries in the catalog.',
    inputSchema: z
      .object({
        id: z.string().optional(),
        file: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Idempotent dry-run check. On failure, the response includes `detail` (root cause) and `suggestedFix` (actionable hint, e.g. correct tool name when a typo is detected). Catch schema mistakes here BEFORE memphis_skill_install — otherwise a half-written draft ends up in the catalog and breaks discovery.',
  },
  memphis_skill_install: {
    name: 'memphis_skill_install',
    tier: 2,
    capabilities: ['write'],
    description:
      'Validate + promote a draft skill into the catalog + installed dirs and record it in the skills registry. After install, the skill is visible to cognitive frames + cron triggers + memphis_skill_list filter=installed.',
    inputSchema: z
      .object({
        id: z.string().optional(),
        file: z.string().optional(),
        force: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Atomically materializes the skill: validates the manifest → copies into ~/.memphis/skills/catalog/<id>/ → mirrors into ~/.memphis/skills/installed/<id>/ → updates ~/.memphis/skills/registry.json. Refuses on schema or unknown-tool errors (run memphis_skill_validate first to see what fails). `force=true` overwrites an existing installed version — use it when iterating on a freshly edited draft of the same id.',
  },
};
