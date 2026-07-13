import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const DEVELOPMENT_TOOLS: Record<string, ToolMeta> = {
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
};
