/**
 * Centralized tool metadata registry.
 *
 * Single source of truth for tool names, tiers, capabilities, and feature gating.
 * Replaces the static KNOWN_TOOLS list in soul/manifest.ts.
 */

import { z } from 'zod';

import type { MemphisFeatureFlag } from '../infra/features/flags.js';
import { isFeatureFlagEnabled } from '../infra/features/flags.js';

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
      'Reads telemetry spans (sourced from `~/.memphis/telemetry/`) over a rolling window and evaluates every defined SLO: tool success rate, p95 latency by tool, vault decrypt error rate, chain append throughput, embed-index health. Each SLO returns `pass | fail | unavailable` with the computed value, threshold, and sample count so the operator can see WHY the runtime is degraded, not just THAT it is. `unavailable` means the SLO has no samples in the window — usually fine for a fresh install, indicates a logging gap on a long-running runtime.',
    cliFlags: [
      {
        name: '--window-days',
        description: 'Rolling window in days (1-90, default 7).',
        takesValue: true,
      },
    ],
  },
  memphis_repair: {
    name: 'memphis_repair',
    tier: 0,
    capabilities: ['write'],
    description:
      'Repair Memphis runtime state — chain integrity, SQLite, migrations, derived indexes',
    inputSchema: z
      .object({
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
        entry: z.object({
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
        }).passthrough(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Append a case entry to the cases chain — Memphis\'s linguistic-case knowledge graph. Each entry is anchored on a Polish grammatical case (nominative/genitive/dative/accusative/instrumental/locative/ablative/vocative) plus role fields (actor, target, instrument, location, etc.) drawn from the operator\'s `entry` payload. Indexed in the SQLite case-index for relational queries via memphis_case_query. Use to record structured observations the embedding index can\'t capture relationally — e.g. "X delegated Y to Z".',
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
  },
  memphis_exec: {
    name: 'memphis_exec',
    tier: 2,
    capabilities: ['execute'],
    description: 'Execute shell command',
    inputSchema: z
      .object({
        command: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
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
        approval_request_id: z.string().optional(),
      })
      .strict(),
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
  },
};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_REGISTRY[name];
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
