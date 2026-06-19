/**
 * Centralized tool metadata registry.
 *
 * Single source of truth for tool names, tiers, capabilities, and feature gating.
 * Replaces the static KNOWN_TOOLS list in soul/manifest.ts.
 */

import { z } from 'zod';

import type { MemphisFeatureFlag } from '../infra/features/flags.js';
import { isFeatureFlagEnabled } from '../infra/features/flags.js';
import { registerKnownToolNames } from '../infra/observability/confabulation-detector.js';

export type ToolTier = 0 | 1 | 2 | 3;
export type ToolCapability = 'read' | 'write' | 'network' | 'execute';

/**
 * A single CLI flag exposed by a tool, used to drive declarative CLI
 * help generation (Sprint E Phase 1 foundation, plan #2 in
 * `~/.claude/plans/memphis-architectural-refactor.md`). Once Phase 2
 * lands, the parser + help renderer iterate over these instead of
 * each tool re-declaring its own help text in
 * `src/infra/cli/handlers/system.handler.ts`.
 */
export interface ToolCliFlag {
  /** Long form, e.g. `--input` or `--cron-pattern`. */
  readonly name: string;
  /** Optional short alias, e.g. `-i`. */
  readonly alias?: string;
  /** One-line operator-facing description. */
  readonly description: string;
  /** Whether the flag accepts a value (`--input hello`) or is boolean. */
  readonly takesValue?: boolean;
  /** Required vs optional — null/undefined ≡ optional. */
  readonly required?: boolean;
}

export interface ToolMeta {
  name: string;
  tier: ToolTier;
  capabilities: ToolCapability[];
  description: string;
  featureFlag?: MemphisFeatureFlag;
  /**
   * Optional Zod schema describing the tool's input shape.
   *
   * When present, surfaces (TUI, GUI, MCP server, custom apps) can use it
   * to render forms, validate input before dispatch, and generate JSON
   * schema for LLM tool-call signatures. Pilot rollout: 5 tier-0 tools
   * (memphis_journal, memphis_recall, memphis_search, memphis_decide,
   * memphis_health). Migration of remaining 32 tool handlers is intentionally
   * deferred to keep the diff isolated to the registry.
   */
  inputSchema?: z.ZodTypeAny;
  /**
   * Operator-facing rich help text. Longer than `description`; used by
   * CLI `--help`, TUI `?` overlay, Telegram `/help`, MCP introspection
   * blurbs. When absent the surface falls back to `description`.
   * Sprint E Phase 1 (this PR) populates 5 high-traffic tools as proof
   * — see plan #2.
   */
  helpText?: string;
  /**
   * Declarative CLI flag list. When present the help renderer can build
   * the `--flag <value> # description` block without bespoke help text.
   * Phase 1 populates the same 5 high-traffic tools as `helpText`.
   */
  cliFlags?: readonly ToolCliFlag[];
}

export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  memphis_journal: {
    name: 'memphis_journal',
    tier: 0,
    capabilities: ['write'],
    description: 'Save entries to journal chain',
    inputSchema: z
      .object({
        content: z.string().min(1, 'content is required'),
        tags: z.array(z.string()).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Append a journal entry to the operator-private journal chain. The chain is local-only by default; entries persist across restarts and feed cognitive Mode E (weekly reflection). Use for thoughts, decisions in flight, observations — NOT as the response channel back to the operator.',
    cliFlags: [
      {
        name: '--content',
        description: 'Journal entry text. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--tags',
        description: 'Comma-separated tags applied to the entry (optional).',
        takesValue: true,
      },
    ],
  },
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
  memphis_health: {
    name: 'memphis_health',
    tier: 0,
    capabilities: ['read'],
    description: 'Check runtime health',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Compact health snapshot: runtime uptime, provider readiness, vault cipher probe, chain integrity, embed pipeline status, recent telemetry. Counterpart to `memphis doctor` but JSON-shaped and faster — use this for programmatic gating, doctor for human triage.',
    cliFlags: [],
  },
  memphis_self_describe: {
    name: 'memphis_self_describe',
    tier: 0,
    capabilities: ['read'],
    description:
      'Runtime self-introspection — returns active surface policy, effective tier (with tier-3 session info), cognitive mode, full tool inventory with availability, feature flags, and cross-surface tier-3 sessions. Use this BEFORE answering "what can you do" — never hallucinate capabilities from training data.',
    inputSchema: z
      .object({
        surface: z.string().optional(),
        actorId: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Compact runtime introspection. Surfaces the LIVE picture: active surface (mcp/cli/telegram/tui/http), effective tool tier (after surface policy + tier-3 elevation), cognitive mode (A-E), the full registered-tool list with each tool\'s availability under the current policy, active feature flags, and cross-surface tier-3 sessions. Operator capability questions ("what can you do", "co potrafisz", "show capabilities") MUST call this first — bot training data is months out of date and will confabulate. Output is JSON-shaped, safe to render to the operator verbatim.',
    cliFlags: [
      {
        name: '--surface',
        description:
          'Override the surface name used for policy resolution (default: caller\'s surface).',
        takesValue: true,
      },
      {
        name: '--actor-id',
        description:
          'Actor id used for tier-3 session lookup on the resolved surface (default: "local").',
        takesValue: true,
      },
    ],
  },
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
  memphis_slo_status: {
    name: 'memphis_slo_status',
    tier: 0,
    capabilities: ['read'],
    description:
      'Runtime SLO snapshot — reads telemetry spans over a time window (default 7 days) and reports each SLO as pass/fail/unavailable with computed value, threshold, and sample count. Use to answer "is the runtime healthy" or to gate alerts.',
    inputSchema: z
      .object({
        windowDays: z.number().int().min(1).max(90).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Reads telemetry spans (sourced from `~/.memphis/telemetry/`) over a rolling window and evaluates the implemented SLOs: p99 turn latency, confabulation rate, provider error rate, and tool error rate. Each SLO returns `pass | fail | unavailable` with computed value, threshold, and sample count so the operator can see WHY the runtime is degraded, not just THAT it is. `unavailable` means the SLO has no samples or fewer than the minimum sample floor in the window — usually fine for a fresh install, but a logging gap on a long-running runtime.',
    cliFlags: [
      {
        name: '--window-days',
        description: 'Rolling window in days (1-90, default 7).',
        takesValue: true,
      },
    ],
  },
  memphis_self_governance_status: {
    name: 'memphis_self_governance_status',
    tier: 0,
    capabilities: ['read'],
    description:
      'Read Memphis self-governance capability state — supervised-operational autonomy readiness, recovery blockers, and required operator actions.',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Canonical answer for "can Memphis steer itself and preserve that ability?". Aggregates runtime health, chain integrity, backup readiness, provider/fallback readiness, scheduler posture, and SLO state into `capable`, `canSelfRecover`, `canSelfModify=false`, `blockingReasons`, and `recommendedActions`. Read-only; it never restarts, repairs, deploys, or edits code.',
    cliFlags: [],
  },
  memphis_tensor_status: {
    name: 'memphis_tensor_status',
    tier: 0,
    capabilities: ['read'],
    description:
      'Read Memphis tensor/vector runtime truth — memory embedding dim/provider/persistence, Kartograf tensor mode, and public raw-vector exposure policy.',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Use this to answer "what do tensors look like in Memphis right now?". Reports Rust memory embeddings (`Vec<f32>`), Kartograf embeddings (`Float32Array`/ONNX), configured dimensions, dtype, persistence, bridge readiness, and whether a legacy index dim mismatch is present. It never returns raw vector values.',
    cliFlags: [],
  },
  memphis_repair: {
    name: 'memphis_repair',
    tier: 0,
    capabilities: ['write'],
    description:
      'Repair Memphis runtime state — chain integrity, SQLite, migrations, derived indexes',
    inputSchema: z
      .object({
        force: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Idempotent repair sweep over runtime state: chain integrity (rebuild missing index entries, drop orphans), SQLite migrations (apply any pending), derived indexes (case-index, embed-index reseed when stale). Safe to call from a healthy runtime — it is a no-op when nothing needs repair. Use after a crash, partial restore, or before the operator runs an export to be sure on-disk state is consistent.',
    cliFlags: [],
  },
  memphis_soul_read: {
    name: 'memphis_soul_read',
    tier: 0,
    capabilities: ['read'],
    description: 'Read soul memory',
    inputSchema: z
      .object({
        section: z.enum(['user', 'self', 'context', 'all']).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Read the operator-private "soul memory" — the curated identity narrative that survives across sessions. Three sections: `user` (operator name, languages, preferences, expertise, integrations), `self` (agent personality, learnings, evolved capabilities), `context` (active work, recent decisions). Default `all` returns every section; pass a specific section to keep the response compact. Soul memory is privacy-sensitive: never log or echo verbatim into untrusted surfaces without redaction.',
    cliFlags: [
      {
        name: '--section',
        description: 'Which section to read: user | self | context | all (default: all).',
        takesValue: true,
      },
    ],
  },
  memphis_soul_write: {
    name: 'memphis_soul_write',
    tier: 0,
    capabilities: ['write'],
    description: 'Update soul memory',
    inputSchema: z
      .object({
        updates: z.object({
          user: z.record(z.string(), z.unknown()).optional(),
          self: z.record(z.string(), z.unknown()).optional(),
          context: z.record(z.string(), z.unknown()).optional(),
        }),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Deep-merge an update into the soul memory file. Three target sections (user/self/context) — only supply the keys you actually want to change; everything else stays untouched. Use to record evolved capabilities (`self.evolvedCapabilities`), update operator preferences (`user.preferences`), or refresh active work (`context.activeWork`). Writes are atomic + permission-tightened (0600). Soul memory is the long-form identity narrative — for ephemeral journal entries use memphis_journal instead.',
    cliFlags: [],
  },
  memphis_case_append: {
    name: 'memphis_case_append',
    tier: 0,
    capabilities: ['write'],
    description: 'Append case entry',
    inputSchema: z
      .object({
        entry: z
          .object({
            case_type: z.enum([
              'nominative',
              'genitive',
              'dative',
              'accusative',
              'instrumental',
              'locative',
              'ablative',
              'vocative',
            ]),
          })
          .passthrough()
          .optional(),
        case_type: z
          .enum([
            'nominative',
            'genitive',
            'dative',
            'accusative',
            'instrumental',
            'locative',
            'ablative',
            'vocative',
          ])
          .optional(),
        entity: z.string().optional(),
        action: z.string().optional(),
        timestamp: z.string().optional(),
        owner: z.string().optional(),
        possessed: z.string().optional(),
        giver: z.string().optional(),
        recipient: z.string().optional(),
        object: z.string().optional(),
        subject: z.string().optional(),
        verb: z.string().optional(),
        actor: z.string().optional(),
        instrument: z.string().optional(),
        target: z.string().optional(),
        location: z.string().optional(),
        origin: z.string().optional(),
        destination: z.string().optional(),
        invoker: z.string().optional(),
        invocation: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .refine((value) => Boolean(value.entry ?? value.case_type), {
        message: 'Provide either entry.case_type or top-level case_type',
      })
      .strict(),
    helpText:
      'Append a case entry to the cases chain — Memphis\'s linguistic-case knowledge graph. Accepts either `{entry:{case_type,...}}` or top-level `{case_type,...}`. Each entry is anchored on a Polish grammatical case (nominative/genitive/dative/accusative/instrumental/locative/ablative/vocative) plus role fields: nominative needs entity/action/timestamp; instrumental needs actor/instrument/target; accusative needs subject/verb/object; locative needs entity/location. Indexed in SQLite for memphis_case_query. Use to record structured observations the embedding index can\'t capture relationally — e.g. "X delegated Y to Z".',
    cliFlags: [],
  },
  memphis_case_query: {
    name: 'memphis_case_query',
    tier: 0,
    capabilities: ['read'],
    description: 'Query case graph',
    inputSchema: z
      .object({
        query: z.object({
          case_type: z.string().optional(),
          entity: z.string().optional(),
          actor: z.string().optional(),
          target: z.string().optional(),
          instrument: z.string().optional(),
          location: z.string().optional(),
          limit: z.number().int().positive().max(100).optional(),
        }),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Relational query over the case-index SQLite store fed by memphis_case_append. Filter by Polish case-type, by entity name, or by any role slot (actor/target/instrument/location). Returns matching case entries with their full block payloads. Prefer over memphis_recall when you need structured "who did what to whom" lookups instead of conceptual similarity.',
    cliFlags: [
      {
        name: '--case-type',
        description: 'Filter by grammatical case (nominative/genitive/dative/...).',
        takesValue: true,
      },
      {
        name: '--entity',
        description: 'Match any role containing this entity name.',
        takesValue: true,
      },
      {
        name: '--actor',
        description: 'Filter by actor role specifically.',
        takesValue: true,
      },
      {
        name: '--limit',
        description: 'Max number of entries to return (default 20, cap 100).',
        takesValue: true,
      },
    ],
  },
  memphis_chain_query: {
    name: 'memphis_chain_query',
    tier: 0,
    capabilities: ['read'],
    description: 'Query raw chain blocks with lightweight filters',
    featureFlag: 'experimental-tools',
    inputSchema: z
      .object({
        chain: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().min(0).optional(),
        blockType: z.string().optional(),
        contains: z.string().optional(),
        tag: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Direct read over a chain\'s block log with simple filters (blockType, substring `contains`, tag match). Returns raw block envelopes including hash + index + signature so the operator can audit chain integrity or pull a specific block by content. Pagination via `offset` + `limit`. Gated behind `experimental-tools` because the surface is intended for diagnostic introspection — for normal recall use memphis_recall (semantic) or memphis_search (literal).',
    cliFlags: [
      {
        name: '--chain',
        description: 'Chain name (journal, decisions, cases, ...). Omit to scan all.',
        takesValue: true,
      },
      {
        name: '--block-type',
        description: 'Filter to one block type (journal, decision, case, ...).',
        takesValue: true,
      },
      {
        name: '--contains',
        description: 'Literal substring match against block content/data.',
        takesValue: true,
      },
      {
        name: '--tag',
        description: 'Match a single tag from the block\'s tags array.',
        takesValue: true,
      },
      {
        name: '--limit',
        description: 'Max blocks (default 20, cap 100).',
        takesValue: true,
      },
      {
        name: '--offset',
        description: 'Skip this many blocks (for pagination).',
        takesValue: true,
      },
    ],
  },
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
  memphis_code_read: {
    name: 'memphis_code_read',
    tier: 2,
    capabilities: ['read'],
    description: 'Read files inside ~/memphis/ (whitelisted, read-only)',
    inputSchema: z
      .object({
        path: z.string().min(1),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(2000).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Read a file inside the Memphis install root or operator data dir. Path is normalized + path-traversal-checked against the whitelist (`/home/memphis/memphis/`, `~/.memphis/`); never escapes that boundary even with relative segments. Supports line-ranged reads (`startLine`/`endLine`) so the LLM can pull a specific block of source without dragging the whole file into context. Read-only — pair with memphis_fs_write for edits, memphis_grep for search.',
    cliFlags: [
      {
        name: '--path',
        description: 'Whitelisted path to read. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--start-line',
        description: 'First line to include (1-indexed).',
        takesValue: true,
      },
      {
        name: '--end-line',
        description: 'Last line to include (inclusive).',
        takesValue: true,
      },
      {
        name: '--limit',
        description: 'Max lines to return (cap 2000).',
        takesValue: true,
      },
    ],
  },
  memphis_grep: {
    name: 'memphis_grep',
    tier: 2,
    capabilities: ['read'],
    description: 'Search code using regex patterns (ripgrep or grep)',
    inputSchema: z
      .object({
        pattern: z.string().min(1),
        path: z.string().optional(),
        glob: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        context: z.number().int().min(0).optional(),
        ignoreCase: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Regex search across the Memphis tree. Uses ripgrep when available, falls back to GNU grep. Defaults to the Memphis install root; `--path` narrows the scan, `--glob` filters by filename pattern (e.g. `**/*.ts`). `--context` returns N lines before/after each match (operator-friendly default 0). Cap of 200 hits prevents runaway output — refine the pattern if you hit the limit.',
    cliFlags: [
      {
        name: '--pattern',
        description: 'Regex pattern. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--path',
        description: 'Subdirectory to scan (relative to Memphis root).',
        takesValue: true,
      },
      {
        name: '--glob',
        description: 'Filename glob filter (e.g. `**/*.ts`).',
        takesValue: true,
      },
      {
        name: '--context',
        description: 'Lines of context before/after each match (default 0).',
        takesValue: true,
      },
      {
        name: '--ignore-case',
        description: 'Case-insensitive matching.',
      },
      {
        name: '--limit',
        description: 'Max matches to return (default 50, cap 200).',
        takesValue: true,
      },
    ],
  },
  memphis_glob: {
    name: 'memphis_glob',
    tier: 2,
    capabilities: ['read'],
    description: 'Find files by glob pattern (fd or find)',
    inputSchema: z
      .object({
        pattern: z.string().min(1),
        path: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'List files matching a glob (e.g. `**/*.ts`, `src/cognitive/*.ts`). Uses fd when available, GNU find otherwise. Companion to memphis_grep — use this to discover candidate files, then grep inside them. Returns paths relative to the search root. Cap of 500 — narrow `--path` if you exceed it.',
    cliFlags: [
      {
        name: '--pattern',
        description: 'Glob pattern (e.g. `**/*.ts`). Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--path',
        description: 'Subdirectory to search (relative to Memphis root).',
        takesValue: true,
      },
      {
        name: '--limit',
        description: 'Max paths to return (cap 500).',
        takesValue: true,
      },
    ],
  },
  memphis_git: {
    name: 'memphis_git',
    tier: 2,
    capabilities: ['read', 'write'],
    description: 'Git operations — all tier 2',
    inputSchema: z
      .object({
        subcommand: z.string().min(1),
        args: z.array(z.string()).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Run a git subcommand against the Memphis tree. Pass the verb (`status`, `diff`, `log`, `add`, `commit`, etc.) as `subcommand` and any extra args as a string array. Tier-2 because mutations (commit/reset/push) need approval — read-only verbs (status/diff/log/show) execute immediately. Force-push, hard reset, hooks-skipping flags (`--no-verify`, `--no-gpg-sign`) and credential modifications stay denied even with approval; use the operator git CLI for those.',
    cliFlags: [
      {
        name: '--subcommand',
        description: 'Git verb (status, diff, log, add, commit, ...). Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--args',
        description: 'Extra args, comma-separated (or passed via JSON in MCP).',
        takesValue: true,
      },
    ],
  },
  memphis_test: {
    name: 'memphis_test',
    tier: 2,
    capabilities: ['execute'],
    description: 'Run project tests (typecheck, lint, vitest, cargo test)',
    inputSchema: z
      .object({
        suite: z.enum(['all', 'ts', 'rust', 'lint', 'typecheck']).optional(),
        filter: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Run a Memphis test suite. `suite` selects: `ts` (vitest), `rust` (cargo test --workspace), `lint` (eslint), `typecheck` (tsc --noEmit), or `all` (sequential). `filter` narrows vitest test names; pass through to cargo via env. Output is captured (capped) and the exit code is the result. Use to gate self-modify or before deploy — pair with memphis_deploy for the full preflight.',
    cliFlags: [
      {
        name: '--suite',
        description: 'Suite to run: all | ts | rust | lint | typecheck (default: all).',
        takesValue: true,
      },
      {
        name: '--filter',
        description: 'Test-name filter (vitest -t, cargo test pattern).',
        takesValue: true,
      },
    ],
  },
  memphis_deploy: {
    name: 'memphis_deploy',
    tier: 2,
    capabilities: ['execute', 'write', 'network'],
    description:
      'Run Memphis deploy, health, and rollback workflows with snapshots and post-checks',
    inputSchema: z
      .object({
        action: z.enum(['run', 'health', 'rollback']).optional(),
        profile: z.enum(['local-service', 'build-only', 'custom']).optional(),
        buildCommand: z.string().optional(),
        deployCommand: z.string().optional(),
        healthUrl: z.string().optional(),
        testSuite: z.enum(['ts', 'rust', 'lint', 'typecheck', 'all']).optional(),
        deep: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        rollbackIndex: z.number().int().min(0).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Three-mode deploy orchestrator. `action: run` snapshots state, builds, deploys (per profile), then runs the health probe + post-checks; rolls back automatically on failure. `action: health` runs the health probe alone (e.g. against an external service). `action: rollback` reverts to a prior snapshot (`rollbackIndex` selects which; default = most recent). Profiles: `local-service` (systemd unit), `build-only` (no deploy), `custom` (operator-supplied build/deploy commands). `dryRun` simulates without touching anything.',
    cliFlags: [
      {
        name: '--action',
        description: 'run | health | rollback (default: run).',
        takesValue: true,
      },
      {
        name: '--profile',
        description: 'local-service | build-only | custom.',
        takesValue: true,
      },
      {
        name: '--build-command',
        description: 'Override build step (custom profile).',
        takesValue: true,
      },
      {
        name: '--deploy-command',
        description: 'Override deploy step (custom profile).',
        takesValue: true,
      },
      {
        name: '--health-url',
        description: 'URL to probe for post-deploy health check.',
        takesValue: true,
      },
      {
        name: '--test-suite',
        description: 'Suite to run as preflight (default: all).',
        takesValue: true,
      },
      {
        name: '--deep',
        description: 'Run deeper post-deploy verification (slower).',
      },
      {
        name: '--dry-run',
        description: 'Show what would happen without mutating anything.',
      },
    ],
  },
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
  memphis_self_plan_create: {
    name: 'memphis_self_plan_create',
    tier: 0,
    capabilities: ['write'],
    description: 'Create a multi-step self-coding plan (durable across turns)',
    inputSchema: z
      .object({
        goal: z.string().min(1),
        steps: z
          .array(z.object({ description: z.string().min(1) }).strict())
          .min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Open a durable plan for a multi-file feature. Provide `goal` (operator-facing one-liner) and `steps` (array of {description}). Each step becomes a unit of work Memphis advances through with `memphis_self_plan_advance`. Plan is persisted to `~/.memphis/state/self-coding-plans.json` so the next turn picks up where the last one left off. Returns the `plan_id` (e.g. `plan-2026-05-12-a4f2`) used by all other plan tools. Tier-0 (data-only); the underlying `memphis_self_modify` calls per step remain tier-2.',
  },
  memphis_self_plan_get: {
    name: 'memphis_self_plan_get',
    tier: 0,
    capabilities: ['read'],
    description: 'Read a self-coding plan by id (returns next pending step too)',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Fetch the current state of a plan. Returns `{plan, next_step}` where `next_step` is the first step with status `pending` or `failed` (failed steps come first so a retry resumes before new work). Call at turn start when continuing a plan: tells you which step to attempt without scanning the history. Returns `{ok:false, error}` if the plan id is unknown.',
  },
  memphis_self_plan_advance: {
    name: 'memphis_self_plan_advance',
    tier: 0,
    capabilities: ['write'],
    description: 'Mark a plan step as done/failed/in_progress/skipped',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        step_idx: z.number().int().nonnegative(),
        status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
        artifact: z.string().optional(),
        error: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Record progress on one step. `status`: pending→in_progress when starting work; in_progress→done on success (pass `artifact` — file path / PR url / sha); in_progress→failed on test red (pass `error` — terse failure message). `attempts` auto-increments on in_progress/failed (so retry counts are tracked). Plan-level status auto-flips planning→executing on first in_progress. Per-step idempotent — same `(plan_id, step_idx)` twice produces the same shape.',
  },
  memphis_self_plan_cancel: {
    name: 'memphis_self_plan_cancel',
    tier: 0,
    capabilities: ['write'],
    description: 'Cancel a self-coding plan with a reason recorded for audit',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        reason: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "End-of-line a plan. Sets status to `cancelled` and records the reason on the first non-terminal step's `lastError` (so operator-side report still has context). Use when scope changed mid-feature, operator redirected, or the plan turned out infeasible.",
  },
  memphis_self_review: {
    name: 'memphis_self_review',
    tier: 0,
    capabilities: ['read'],
    description: 'Pre-PR review of a self-coding plan: gap/scope-creep/TODO check',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "Run before `memphis_self_pr_open` to catch plan drift. Reports four classes of issue: (1) steps marked `done` with no artifact recorded (plan-store corruption); (2) non-terminal steps left over (unfinished work); (3) files in the plan's diff that no step description names (scope creep); (4) added TODO/FIXME/XXX/HACK markers (technical debt). Returns `{ok, checklist, blockers[]}`. Per-step lint+typecheck are NOT re-run — those already ran inside `memphis_self_modify`'s test gate at commit time.",
  },
  memphis_self_pr_open: {
    name: 'memphis_self_pr_open',
    tier: 2,
    capabilities: ['execute', 'network'],
    description: 'Push the plan branch and open a PR via gh (operator must merge)',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        title: z.string().optional(),
        body_prefix: z.string().optional(),
        branch: z.string().optional(),
        base: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "Close a plan by pushing its branch and opening a PR. Required: every step is `done` or `skipped` (preflight rejects unfinished plans). Auto-derives PR title from `plan.goal` and body from the step list (status markers + artifact + retry counts). Sets plan status to `pr-open` + records the returned PR url. Tier-2 because this opens a real PR visible to teammates; the operator passphrase gate at the policy layer enforces explicit approval. **Memphis NEVER merges its own PR** — only operator does, by design. Refuses to push from `main`/`master`/the configured base.",
  },
  memphis_self_deploy_verify: {
    name: 'memphis_self_deploy_verify',
    tier: 0,
    capabilities: ['read', 'execute'],
    description: 'C-step: confirm the merged PR is on origin/main and the build is fresh',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        build_artifact_path: z.string().optional(),
        base: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Verify a plan actually shipped. After operator merges the PR from `memphis_self_pr_open`, call this to confirm: (1) PR is merged via gh, (2) merge commit is an ancestor of origin/main (local fetch happens first), (3) build artifact mtime is newer than the merge timestamp (proves a rebuild happened). On all three green, sets plan status to `done`. If anything fails, plan stays in `pr-open` and the operator-facing report names which check failed.',
  },
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
  memphis_fs_write: {
    name: 'memphis_fs_write',
    tier: 2,
    capabilities: ['write'],
    description: 'Write or append to files inside ~/memphis/ (blocks sensitive paths)',
    inputSchema: z
      .object({
        path: z.string().min(1),
        content: z.string(),
        mode: z.enum(['write', 'append', 'overwrite']).optional(),
        createDirs: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Write file content to a whitelisted path inside the Memphis tree. Sensitive paths (vault-state, vault-entries, anything under `~/.memphis/keys/`, `~/.ssh/`, system dirs) are denied at the path-check layer regardless of approval. Three modes: `write` fails if the file exists (safest default), `append` adds to the end, `overwrite` replaces any existing content. `createDirs` creates parent directories as needed (0700). Audit chain captures path + mode + content hash.',
    cliFlags: [
      {
        name: '--path',
        description: 'Whitelisted path to write to. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--mode',
        description: 'write (refuse-if-exists) | append | overwrite. Default: write.',
        takesValue: true,
      },
      {
        name: '--create-dirs',
        description: 'Create parent directories if missing.',
      },
    ],
  },
  memphis_fs_ops: {
    name: 'memphis_fs_ops',
    tier: 2,
    capabilities: ['write'],
    description: 'Filesystem operations: copy, move, delete, mkdir, stat (sandboxed to ~/memphis/)',
    inputSchema: z
      .object({
        operation: z.enum(['copy', 'move', 'delete', 'mkdir', 'stat']),
        source: z.string().min(1),
        destination: z.string().optional(),
        recursive: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Five filesystem primitives: `copy` (src → dest), `move` (rename), `delete` (rm), `mkdir` (create dir), `stat` (read metadata). All sandboxed to the Memphis tree — same denylist as memphis_fs_write. `recursive` applies to copy/delete/mkdir. `delete` is destructive — even with approval, use sparingly; backups are NOT automatic here (use memphis_self_modify for changes that should be snapshot-protected).',
    cliFlags: [
      {
        name: '--operation',
        description: 'copy | move | delete | mkdir | stat. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--source',
        description: 'Source path. Required for all operations.',
        takesValue: true,
        required: true,
      },
      {
        name: '--destination',
        description: 'Destination path (required for copy/move).',
        takesValue: true,
      },
      {
        name: '--recursive',
        description: 'Apply recursively (copy/delete/mkdir).',
      },
    ],
  },
  memphis_web_search: {
    name: 'memphis_web_search',
    tier: 2,
    capabilities: ['network', 'read'],
    description: 'Search the web via DuckDuckGo (no API key needed)',
    inputSchema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(10).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'DuckDuckGo HTML search — no API key, no SerpAPI dependency. Returns up to 10 results (title + URL + snippet). Use to discover URLs to feed into memphis_web_fetch; for live up-to-date facts the operator just asked about. Don\'t use as a replacement for memphis_recall on Memphis-internal knowledge — that\'s in chains, not the web.',
    cliFlags: [
      {
        name: '--query',
        description: 'Search query. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--limit',
        description: 'Max results to return (cap 10).',
        takesValue: true,
      },
    ],
  },
  memphis_brave_search: {
    name: 'memphis_brave_search',
    tier: 2,
    capabilities: ['network', 'read'],
    description: 'Search the web via Brave Search API (requires BRAVE_API_KEY)',
    inputSchema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(20).optional(),
        country: z.string().length(2).optional(),
        search_lang: z.string().length(2).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Brave Search API (paid tier — free 2000 queries/month at https://api.search.brave.com/). Returns up to 20 structured JSON results combining web + news. Higher quality than memphis_web_search (DuckDuckGo HTML scrape) when an API key is available; prefer this if BRAVE_API_KEY is set. Optional country (ISO-2, e.g. PL) + search_lang for region-localized results.',
    cliFlags: [
      {
        name: '--query',
        description: 'Search query. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--limit',
        description: 'Max results to return (cap 20).',
        takesValue: true,
      },
      {
        name: '--country',
        description: 'ISO 3166-1 alpha-2 country code (e.g. PL, US).',
        takesValue: true,
      },
      {
        name: '--search-lang',
        description: 'ISO 639-1 language code (e.g. pl, en).',
        takesValue: true,
      },
    ],
  },
  memphis_media_ingest: {
    name: 'memphis_media_ingest',
    tier: 2,
    capabilities: ['network', 'read', 'write'],
    description:
      'Ingest a media file (audio/image) — transcribe + describe via local LLM, write to chains',
    inputSchema: z
      .object({
        path: z.string().min(1),
        type: z.enum(['audio', 'image', 'video', 'auto']).optional(),
        dryRun: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Process a media file through the local LLM stack (Memphis B3): audio → whisper-server transcription → journal chain; image → Ollama vision (moondream / llava / granite3.2-vision) → journal chain with description + auto-tags. Video is recognised but not yet implemented (B4 scope). Path is mandatory; type defaults to auto-detect from extension. Set --dry-run to call the adapter without writing chains (handy when iterating on prompts). Reuses the existing local-whisper voice stack on :9000 and the standard Ollama provider — no new daemons, no cloud calls. See docs/dev/media-pipeline-b1-architecture.md and -b2-modules.md for the spec.',
    cliFlags: [
      {
        name: '--path',
        description: 'Path to the media file. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--type',
        description: 'audio | image | video | auto (default: auto, from extension)',
        takesValue: true,
      },
      {
        name: '--dry-run',
        description: 'Run the adapter but skip chain writes (debug / prompt iteration).',
        takesValue: false,
      },
    ],
  },
  memphis_package: {
    name: 'memphis_package',
    tier: 2,
    capabilities: ['execute'],
    description: 'Package manager operations (npm, cargo, apt, pip)',
    inputSchema: z
      .object({
        manager: z.enum(['npm', 'cargo', 'apt', 'pip']),
        action: z.enum(['install', 'remove', 'list', 'search']),
        packages: z.array(z.string()).optional(),
        global: z.boolean().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Wrapper around four package managers — npm/cargo/apt/pip. Four actions: `install` (add deps), `remove` (uninstall), `list` (show installed), `search` (lookup). `apt` requires sudo + tier-3 session; the others run as the Memphis user. Adding new deps to npm/cargo also requires the dep-freeze-check classification gate (see DEPENDENCY-POLICY.md) at PR time — this tool only handles the actual install, not policy.',
    cliFlags: [
      {
        name: '--manager',
        description: 'npm | cargo | apt | pip. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--action',
        description: 'install | remove | list | search. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--packages',
        description: 'Comma-separated package names (or JSON array via MCP).',
        takesValue: true,
      },
      {
        name: '--global',
        description: 'Install globally (npm -g, pip --user).',
      },
    ],
  },
  memphis_db: {
    name: 'memphis_db',
    tier: 2,
    capabilities: ['read', 'write'],
    description: 'Query and manage SQLite databases inside ~/memphis/',
    inputSchema: z
      .object({
        action: z.enum(['query', 'execute', 'tables', 'schema']),
        sql: z.string().optional(),
        database: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Direct SQLite access for the Memphis runtime\'s on-disk databases (memphis.db default; tool-permissions, evolve-sessions, case-index can be targeted via `database`). Four actions: `query` (SELECT, returns rows), `execute` (INSERT/UPDATE/DELETE/DDL, returns affected count), `tables` (list tables in the target db), `schema` (CREATE TABLE statements). Use for diagnostic introspection or one-off corrections — schema changes should go through migrations (`src/infra/storage/sqlite/migrations/`) not ad-hoc execute, otherwise they get reverted on next restart.',
    cliFlags: [
      {
        name: '--action',
        description: 'query | execute | tables | schema. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--sql',
        description: 'SQL statement (required for query/execute).',
        takesValue: true,
      },
      {
        name: '--database',
        description: 'Database file (default: memphis.db).',
        takesValue: true,
      },
    ],
  },
  memphis_build: {
    name: 'memphis_build',
    tier: 2,
    capabilities: ['execute'],
    description: 'Auto-detect project type and run build (npm, cargo, python)',
    inputSchema: z
      .object({
        project: z.string().optional(),
        command: z.string().optional(),
        profile: z.enum(['debug', 'release']).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Run a project build. Without `command`, auto-detects from manifests in the target directory (package.json → `npm run build`, Cargo.toml → `cargo build`, pyproject.toml → `python -m build`). `profile=release` propagates to cargo (`--release`); ignored otherwise. Captures stdout + stderr (cap 256KB). Pair with memphis_test before memphis_deploy when changing source code.',
    cliFlags: [
      {
        name: '--project',
        description: 'Project subdir (default: install root).',
        takesValue: true,
      },
      {
        name: '--command',
        description: 'Override the auto-detected build command.',
        takesValue: true,
      },
      {
        name: '--profile',
        description: 'debug | release (cargo-only).',
        takesValue: true,
      },
    ],
  },
  memphis_health_check: {
    name: 'memphis_health_check',
    tier: 1,
    capabilities: ['network'],
    description: 'HTTP health checks against one or more targets',
    inputSchema: z
      .object({
        targets: z.array(
          z.object({
            url: z.string().url(),
            timeout: z.number().int().positive().optional(),
            expectedStatus: z.number().int().positive().optional(),
          }),
        ).min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Probe one or more HTTP endpoints in parallel. Each target gets a status (ok / unhealthy / timeout / unreachable), measured latency, and a comparison against `expectedStatus` (default 200). Tier-1 because it makes network requests but is read-only and operator-supplied URLs are explicit. Use to gate deploys, monitor downstream services, or verify the runtime\'s own /health endpoint after a restart.',
    cliFlags: [],
  },
  memphis_providers: {
    name: 'memphis_providers',
    tier: 0,
    capabilities: ['read'],
    description: 'Inspect configured providers, default models, and discovered model lists',
    featureFlag: 'experimental-tools',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Snapshot of LLM provider configuration: which providers are wired (Ollama/Anthropic/OpenAI/GLM/...), which is the default per Ollama-first cascade, what model each provider has selected, and the discovered-model list per provider (where supported). Use to answer "which model are you actually using" or to debug "why is Ollama not the fallback" — the cascade picks Ollama first by design but each layer can be overridden via env. Gated behind `experimental-tools` because the introspection surface is intentionally diagnostic-only.',
    cliFlags: [],
  },
  memphis_system_info: {
    name: 'memphis_system_info',
    tier: 0,
    capabilities: ['read'],
    description: 'Inspect host and Memphis runtime system details',
    featureFlag: 'experimental-tools',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Host + runtime fingerprint: OS / arch / Node version / Rust toolchain / NAPI binary triple / install root / data dir / Memphis version. Pure read-only. Operators use this to confirm "is Memphis running on the box I think it is" before committing to actions; LLM uses it to disambiguate platform-specific advice (e.g. apt vs brew, systemd vs launchd). No PII, no secrets — safe to render to any surface. Gated behind `experimental-tools` for parity with memphis_providers.',
    cliFlags: [],
  },
  memphis_presence: {
    name: 'memphis_presence',
    tier: 0,
    capabilities: ['read'],
    description: 'Cross-surface presence snapshot (TUI / Telegram / HTTP)',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Returns when each surface (TUI / Telegram / HTTP / MCP) was last active — last message time, last tool call, current cognitive mode per surface. Sourced from `core/surface-presence.ts` (recordSurfaceActivity) which writes on every inbound event. Use to answer "is the operator on Telegram right now" or "did the TUI session disconnect". Pure read-only; no side effects.',
    cliFlags: [],
  },
  memphis_config_show: {
    name: 'memphis_config_show',
    tier: 0,
    capabilities: ['read'],
    description: 'Show current runtime config (redacted)',
    inputSchema: z
      .object({
        key: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Read the current runtime config — every key in the env schema with its mutability classification (mutable/cold/secret) and current value. Secret-classified fields are redacted; mutable + cold show plaintext. `key` narrows to one entry. Use to answer "what value is X right now" or to verify a config_set landed. Companion to memphis_config_set + memphis_config_reload.',
    cliFlags: [
      {
        name: '--key',
        description: 'Single config key to show (default: all).',
        takesValue: true,
      },
    ],
  },
  memphis_config_reload: {
    name: 'memphis_config_reload',
    tier: 2,
    capabilities: ['write'],
    description: 'Re-read .env and hot-swap mutable fields',
    inputSchema: z
      .object({
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Re-read `.env` and apply hot-swappable changes without restarting. Mutable fields (LOG_LEVEL, MEMPHIS_VOICE_MODE, provider keys, etc.) propagate to live loggers + caches via post-apply hooks. Cold fields (anything that affects boot wiring — DATABASE_URL, MEMPHIS_AGENT_NAME, RUST_CHAIN_BRIDGE_PATH) are listed in the response but NOT applied — those need memphis_restart. Use after editing `.env` or after memphis_config_set on a hot key.',
    cliFlags: [],
  },
  memphis_restart: {
    name: 'memphis_restart',
    tier: 2,
    capabilities: ['write'],
    description: 'Request a self-restart (tier-3 session required)',
    inputSchema: z
      .object({
        reason: z.string().optional(),
        actor_id: z.string().optional(),
        passphrase: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Restart the Memphis runtime in-place. Tier-2 + tier-3 session required (passphrase-gated) — operator-only by design, since restart drops in-flight conversations and resets cognitive context. The audit chain logs `reason` for forensics. Use after applying cold-field config changes (memphis_config_set on cold fields) or after memphis_self_modify to load the new code. Passphrase field is redacted in the persisted approval record.',
    cliFlags: [
      {
        name: '--reason',
        description: 'Operator-facing reason for the restart (audit trail).',
        takesValue: true,
      },
      {
        name: '--passphrase',
        description: 'Operator passphrase (required for tier-3 elevation).',
        takesValue: true,
      },
    ],
  },
  memphis_config_set: {
    name: 'memphis_config_set',
    tier: 2,
    capabilities: ['write'],
    description:
      'Set a single config key/value. Cold fields refuse; secret fields require operator passphrase.',
    inputSchema: z
      .object({
        key: z.string().min(1),
        value: z.string(),
        passphrase: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Update a single config key in `.env`, then trigger hot-reload for mutable fields. Three classifications (per `src/infra/config/mutability.ts`): `mutable` (apply immediately), `cold` (refuses with 409 — operator must edit `.env` + restart), `secret` (requires operator passphrase, redacted in audit). Vault-resolved fields (vault://...) get their plaintext stored encrypted — never logged. Use for one-shot tweaks; for bulk changes edit `.env` directly + run memphis_config_reload.',
    cliFlags: [
      {
        name: '--key',
        description: 'Config key. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--value',
        description: 'New value. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--passphrase',
        description: 'Operator passphrase (required for secret-classified keys).',
        takesValue: true,
      },
    ],
  },
  memphis_cognitive_mode_set: {
    name: 'memphis_cognitive_mode_set',
    tier: 2,
    capabilities: ['write'],
    description: 'Switch cognitive mode (A–E). Requires operator passphrase.',
    inputSchema: z
      .object({
        mode: z.enum(['A', 'B', 'C', 'D', 'E']),
        passphrase: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Switch the active cognitive mode. Modes: `A` (capture, default — temperature low, fast deterministic), `B` (inferred — Model B decision pattern recognition), `C` (predictive — Model C pattern projection), `D` (collective — multi-agent coordination), `E` (meta — weekly reflection synthesis). The mode change writes to soul-manifest, broadcasts on the system chain, and updates the heartbeat watchdog. Passphrase-gated to prevent surface-side mode flips. Operators usually change mode via `/mode A|B|C|D|E` in Telegram or `memphis trust mode set` in CLI; this MCP tool exists for programmatic flips.',
    cliFlags: [
      {
        name: '--mode',
        description: 'Target mode: A | B | C | D | E. Required.',
        takesValue: true,
        required: true,
      },
      {
        name: '--passphrase',
        description: 'Operator passphrase. Required.',
        takesValue: true,
        required: true,
      },
    ],
  },
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
