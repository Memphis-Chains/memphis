import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const FOUNDATION_TOOLS: Record<string, ToolMeta> = {
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
      "DuckDuckGo HTML search — no API key, no SerpAPI dependency. Returns up to 10 results (title + URL + snippet). Use to discover URLs to feed into memphis_web_fetch; for live up-to-date facts the operator just asked about. Don't use as a replacement for memphis_recall on Memphis-internal knowledge — that's in chains, not the web.",
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
      "Direct SQLite access for the Memphis runtime's on-disk databases (memphis.db default; tool-permissions, evolve-sessions, case-index can be targeted via `database`). Four actions: `query` (SELECT, returns rows), `execute` (INSERT/UPDATE/DELETE/DDL, returns affected count), `tables` (list tables in the target db), `schema` (CREATE TABLE statements). Use for diagnostic introspection or one-off corrections — schema changes should go through migrations (`src/infra/storage/sqlite/migrations/`) not ad-hoc execute, otherwise they get reverted on next restart.",
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
        targets: z
          .array(
            z.object({
              url: z.string().url(),
              timeout: z.number().int().positive().optional(),
              expectedStatus: z.number().int().positive().optional(),
            }),
          )
          .min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "Probe one or more HTTP endpoints in parallel. Each target gets a status (ok / unhealthy / timeout / unreachable), measured latency, and a comparison against `expectedStatus` (default 200). Tier-1 because it makes network requests but is read-only and operator-supplied URLs are explicit. Use to gate deploys, monitor downstream services, or verify the runtime's own /health endpoint after a restart.",
    cliFlags: [],
  },
};
