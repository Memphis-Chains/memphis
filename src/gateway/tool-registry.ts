/**
 * Centralized tool metadata registry.
 *
 * Single source of truth for tool names, tiers, capabilities, and feature gating.
 * Replaces the static KNOWN_TOOLS list in soul/manifest.ts.
 */

import { z } from 'zod';

import type { ToolMeta, ToolTier } from './tool-metadata.js';
import { DEVELOPMENT_TOOLS } from './tool-registry/development.js';
import { FOUNDATION_TOOLS } from './tool-registry/foundation.js';
import { LR_DASHBOARD_TOOL } from './tool-registry/lr-dashboard.js';
import { JOURNAL_TOOL } from './tool-registry/memory.js';
import { RUNTIME_CONTROL_TOOLS } from './tool-registry/runtime-control.js';
import { RUNTIME_HEALTH_TOOLS } from './tool-registry/runtime-health.js';
import { SELF_MANAGEMENT_TOOLS } from './tool-registry/self-management.js';
import { SKILL_TOOLS } from './tool-registry/skills.js';
import { SOUL_TOOLS } from './tool-registry/soul.js';
import { STORAGE_TOOLS } from './tool-registry/storage.js';
import { isFeatureFlagEnabled } from '../infra/features/flags.js';
import { registerKnownToolNames } from '../infra/observability/confabulation-detector.js';

export type { ToolCapability, ToolCliFlag, ToolMeta, ToolTier } from './tool-metadata.js';

export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  memphis_journal: JOURNAL_TOOL,
  memphis_kartograf: {
    name: 'memphis_kartograf',
    tier: 1,
    capabilities: ['read'],
    description:
      'Run Kartograf inference on a text — returns a 256-d embedding plus zone classification across the 12 canonical chain slots. Requires an installed checkpoint (`memphis kartograf install`) and MEMPHIS_KARTOGRAF_ENABLE=1. When the runtime is disabled or no checkpoint is staged, returns a structured error rather than silently degrading to zero vectors.',
    inputSchema: z
      .object({
        query: z.string().min(1).max(8192),
        top_k_zones: z.number().int().min(1).max(12).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Use this BEFORE writing to a chain when you need a confident routing decision — the zone with highest score names the chain Kartograf thinks the text belongs to. `top_k_zones=3` is a good default for human-facing reports; omit it to get the full softmax. Output includes `checkpointId` (sha256 of the active ONNX model) so audit logs can pin which model version produced the routing. ⚠ Kartograf v1 has recall@10 = 0.27 — treat the top zone as a hint, not a hard route; corroborate via memphis_recall when stakes are high.',
  },
  memphis_lr_dashboard: LR_DASHBOARD_TOOL,
  memphis_recall: {
    name: 'memphis_recall',
    tier: 0,
    capabilities: ['read'],
    description: 'Semantic search across chains',
    inputSchema: z
      .object({
        query: z.string().min(1, 'query is required'),
        // Aligned with src/mcp/server.ts memphis_recall validator: limit ≤ 50.
        limit: z.number().int().positive().max(50).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Vector-similarity search over every indexed chain (journal, decisions, cases, patterns, reflections, system, collective, proactive, insights, soul, messages). Returns up to `limit` hits ranked by embedding cosine. Prefer over memphis_search when the query is conceptual rather than literal.',
    cliFlags: [
      {
        name: '--query',
        description: 'Natural-language query. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--limit',
        description: 'Max number of hits to return (default 10, cap 50).',
        takesValue: true,
      },
    ],
  },
  memphis_search: {
    name: 'memphis_search',
    tier: 0,
    capabilities: ['read'],
    description: 'Exact phrase search across indexed memory',
    inputSchema: z
      .object({
        query: z.string().min(1, 'query is required'),
        // Aligned with src/mcp/server.ts memphis_search validator: limit ≤ 50,
        // chain is required non-empty when provided.
        limit: z.number().int().positive().max(50).optional(),
        chain: z.string().min(1).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Literal substring / regex search over chain blocks. Faster than memphis_recall but only matches exact text. Use for "find the block that contains X". `--chain` narrows the scan to a single chain by name (uses the same alias table as memphis_chain_query).',
    cliFlags: [
      {
        name: '--query',
        description: 'Phrase to match (literal substring; quote it if it has spaces).',
        takesValue: true,
        required: true,
      },
      {
        name: '--chain',
        description:
          'Optional chain to scan (e.g. journal, decisions). Omit to search every chain.',
        takesValue: true,
      },
      {
        name: '--limit',
        description: 'Max number of hits to return (default 10, cap 50).',
        takesValue: true,
      },
    ],
  },
  memphis_decide: {
    name: 'memphis_decide',
    tier: 0,
    capabilities: ['write'],
    description: 'Record decisions',
    inputSchema: z
      .object({
        title: z.string().min(1, 'title is required'),
        choice: z.string().min(1, 'choice is required'),
        context: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Append a decision record to the decisions chain — title, the choice taken, optional context. Decisions feed Model B inference (decision-pattern recognition) and the operator-facing audit trail. Use when the agent commits to an action that should be reviewable later, NOT for free-form thoughts (those go through memphis_journal).',
    cliFlags: [
      {
        name: '--title',
        description: 'Short label for the decision. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--choice',
        description: 'The decision actually taken. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--context',
        description: 'Optional rationale or background notes.',
        takesValue: true,
      },
    ],
  },
  ...SKILL_TOOLS,
  ...RUNTIME_HEALTH_TOOLS,
  ...SOUL_TOOLS,
  ...STORAGE_TOOLS,
  memphis_loop_step: {
    name: 'memphis_loop_step',
    tier: 0,
    capabilities: ['read'],
    description: 'Loop enforcement',
    inputSchema: z
      .object({
        state: z.object({
          steps: z.number().int(),
          tool_calls: z.number().int(),
          wait_ms: z.number().int(),
          errors: z.number().int(),
          completed: z.boolean(),
          halt_reason: z.string().nullable(),
        }),
        action: z.object({
          type: z.enum(['tool_call', 'wait', 'complete', 'error']),
          data: z.record(z.string(), z.unknown()),
        }),
        limits: z.object({
          max_steps: z.number().int(),
          max_tool_calls: z.number().int(),
        }).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Pure-function loop-engine step driver. Takes the current loop `state` (steps taken, tool_calls used, errors, completion flag) plus a proposed `action` (tool_call/wait/complete/error) and limits (max_steps, max_tool_calls), and returns the next allowed action — `continue`, `halt(reason)`, or `error(reason)`. This is the runtime safety boundary that prevents runaway agent loops; the cognitive layer must call it BEFORE executing the next step. JSON-shaped, deterministic, no I/O.',
    cliFlags: [],
  },
  memphis_web_fetch: {
    name: 'memphis_web_fetch',
    tier: 2,
    capabilities: ['network', 'read'],
    description: 'Fetch public URL',
    inputSchema: z
      .object({
        url: z.string().url(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'GET a public HTTP(S) URL and return the body (truncated to safe length). Network-capability tool — surface policy controls whether it\'s available (Telegram blocks by default; CLI/MCP allow with approval). Returns content-type + body; redirects followed up to 5 hops; 30s timeout. Use to read external docs/APIs the operator referenced; do NOT use for crawling — narrow targets only.',
    cliFlags: [
      {
        name: '--url',
        description: 'Absolute http(s) URL. Required.',
        takesValue: true,
        required: true,
      },
    ],
  },
  ...DEVELOPMENT_TOOLS,
  memphis_cron: {
    name: 'memphis_cron',
    tier: 2,
    capabilities: ['execute', 'write'],
    description: 'Manage scheduled tasks (list, add, remove, enable, disable)',
    inputSchema: z
      .object({
        action: z.enum(['list', 'add', 'remove', 'enable', 'disable']),
        cron: z.string().optional(),
        name: z.string().optional(),
        taskType: z.enum(['shell', 'reflection', 'git-pull-build', 'http']).optional(),
        script: z.string().optional(),
        url: z.string().optional(),
        method: z.string().optional(),
        taskId: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Manage recurring Memphis-internal scheduled tasks (NOT crontab and NOT a one-off reminder/alarm system — these run inside the runtime, audited via the system chain). Four task types: `shell` (operator script), `reflection` (cognitive Mode E periodic run), `git-pull-build` (refresh + rebuild), `http` (poll an endpoint). `list` shows current schedule; `add` registers a recurring task with cron-pattern + handler; `remove` deletes by id; `enable`/`disable` toggle without removing.',
    cliFlags: [
      {
        name: '--action',
        description: 'list | add | remove | enable | disable. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--cron',
        description:
          'Recurring 5-field cron expression (e.g. `0 9 * * 1-5`). Required for add.',
        takesValue: true,
      },
      {
        name: '--name',
        description: 'Operator-friendly task name.',
        takesValue: true,
      },
      {
        name: '--task-type',
        description: 'shell | reflection | git-pull-build | http.',
        takesValue: true,
      },
      {
        name: '--script',
        description: 'Shell script body (for task-type=shell).',
        takesValue: true,
      },
      {
        name: '--url',
        description: 'Target URL (for task-type=http).',
        takesValue: true,
      },
      {
        name: '--task-id',
        description: 'Task id (for remove/enable/disable).',
        takesValue: true,
      },
    ],
  },
  memphis_exec_analyze: {
    name: 'memphis_exec_analyze',
    tier: 1,
    capabilities: ['read'],
    description:
      'Pre-exec analysis: parse a command and predict its side-effects without running it',
    inputSchema: z
      .object({
        command: z.string().min(1),
        surface_intent: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "Call BEFORE `memphis_exec` for any command that isn't obviously read-only. Returns `{parsed, semantic, side_effects, files_touched, reversibility, tier_required, dry_run_command?, warnings, recommendation}`. Recommendation values: `safe-to-run` (just execute), `analyze-then-run` (surface the analysis to the operator first), `ask-operator` (irreversible — must get explicit go-ahead), `refuse` (touches vault/protected paths — never run regardless of tier). Pure parser + heuristics; safe to call at any tier without side effects.",
  },
  memphis_exec: {
    name: 'memphis_exec',
    tier: 2,
    capabilities: ['execute'],
    description: 'Execute shell command',
    inputSchema: z
      .object({
        command: z.string().min(1),
        surface_intent: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "Run a shell command in the Memphis runtime context (cwd: install root, env: filtered). Tier-2 with approval-required default — operator must whitelist or one-shot approve before each call. Stdout + stderr are returned together (capped at 64KB). At tier-3, the allowlist + metachar block are dropped; the wisdom doctrine (soul-seed `exec wisdom` section) tells the agent to call `memphis_exec_analyze` FIRST and surface predicted impact before running anything destructive. `surface_intent` (optional) — the operator's high-level prompt that prompted this exec; appears in audit logs alongside the predicted-vs-actual outcome. Failure budget: after 3 consecutive non-zero exits in a row, further calls are refused with a 'stop blind-retrying' error — call any non-exec tool to reset.",
    cliFlags: [
      {
        name: '--command',
        description:
          'Shell command to run. Quote it; spaces are literal, not argv split here. Required.',
        takesValue: true,
        required: true,
      },
    ],
  },
  ...SELF_MANAGEMENT_TOOLS,
  memphis_self_modify: {
    name: 'memphis_self_modify',
    tier: 2,
    capabilities: ['write', 'execute'],
    description: 'Safe self-modification with snapshot, branch isolation, and test gate',
    inputSchema: z
      .object({
        intent: z.string().min(1),
        files: z.array(z.string()).min(1),
        changes: z.record(z.string(), z.string()),
        passphrase: z.string().optional(),
        // S5 A.5.3 step-aware mode (optional, backward-compatible).
        plan_id: z.string().optional(),
        step_idx: z.number().int().nonnegative().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'The supervised self-modification surface. Takes an `intent` (one-line description for audit), a `files` array (paths to modify), and a `changes` map (path → new content). Pipeline: (1) snapshot the current tree to `~/.memphis/backups/`, (2) apply changes on an isolated branch, (3) run the test gate (typecheck + lint + vitest). On gate failure: auto-rollback to the snapshot. On gate pass: present the diff for operator approval. Tier-2 with passphrase requirement — never bypass the test gate even for "trivial" edits. The audit chain records every attempt regardless of outcome. **Step-aware mode:** pass `plan_id`+`step_idx` to tie a write into a running self-coding plan (see memphis_self_plan_*). The tool marks the step `in_progress` upfront and flips to `done` (with commit hash as artifact) or `failed` (with error message) on exit; a step already `done` is rejected to keep retries idempotent.',
    cliFlags: [],
  },
  ...FOUNDATION_TOOLS,
  ...RUNTIME_CONTROL_TOOLS,
};

// Register tool names with the confabulation detector so its rule-E
// branch (hallucinated `memphis_*` in code-fence) can emit a "did you
// mean ..." suggestion based on Levenshtein distance against this set.
// Module-load side effect — runs once when tool-registry is imported.
registerKnownToolNames(Object.keys(TOOL_REGISTRY));

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_REGISTRY[name];
}

/**
 * Resolve the operator-facing description for a tool, preferring the
 * richer `helpText` from Phase 1 over the one-line `description` when
 * available. Sprint E Phase 2 (this commit) wires this into the
 * surfaces that previously hardcoded their own strings (MCP server
 * registration, system-prompt auto-gen, CLI/TUI/Telegram help).
 *
 * Falls back gracefully:
 *   1. `helpText` (rich, multi-sentence) — populated for ~5 tools today
 *   2. `description` (one-liner, every registered tool has it)
 *   3. Hard-coded fallback string when name is unknown — surfaces as a
 *      visible bug rather than empty output, so a typo in a caller
 *      doesn't silently swallow help text.
 */
export function getToolDescription(name: string): string {
  const meta = TOOL_REGISTRY[name];
  if (!meta) return `tool "${name}" not registered`;
  return meta.helpText ?? meta.description;
}

export function isToolEnabledByFeatureFlag(
  name: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const meta = getToolMeta(name);
  if (!meta) return false;
  return !meta.featureFlag || isFeatureFlagEnabled(meta.featureFlag, rawEnv);
}

export function getToolNames(rawEnv: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(TOOL_REGISTRY)
    .filter((tool) => isToolEnabledByFeatureFlag(tool.name, rawEnv))
    .map((tool) => tool.name);
}

export function getToolsByTier(
  tier: ToolTier,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ToolMeta[] {
  return Object.values(TOOL_REGISTRY).filter(
    (tool) => tool.tier === tier && isToolEnabledByFeatureFlag(tool.name, rawEnv),
  );
}
