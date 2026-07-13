import { AppError } from '../../../core/errors.js';
import { runMemphisBraveSearch } from '../../../mcp/tools/brave-search.js';
import { runMemphisBuild } from '../../../mcp/tools/build.js';
import { runMemphisDb } from '../../../mcp/tools/db.js';
import { runMemphisFsOps } from '../../../mcp/tools/fs-ops.js';
import { runMemphisFsWrite } from '../../../mcp/tools/fs-write.js';
import { runMemphisHealthCheck } from '../../../mcp/tools/health-check.js';
import { runMemphisMediaIngest } from '../../../mcp/tools/media-ingest.js';
import { runMemphisPackage } from '../../../mcp/tools/package.js';
import { runMemphisWebSearch } from '../../../mcp/tools/web-search.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  optionalBoolean,
  optionalIntegerInRange,
  optionalNumber,
  optionalString,
  optionalStringArray,
  optionalStringLength,
  requiredString,
} from '../input-normalization.js';

export function createFoundationRuntimeTools(rawEnv?: NodeJS.ProcessEnv): RuntimeToolDefinition[] {
  return [
    // ── Foundation tools ────────────────────────────────────────────

    buildTool({
      name: 'memphis_fs_write',
      description:
        'Write/append/overwrite files. Inside ~/memphis/: unrestricted. ' +
        'Outside: create-new is always allowed; append and overwrite require tier 3.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to write' },
          mode: { type: 'string', enum: ['write', 'append', 'overwrite'] },
          createDirs: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          path: requiredString(args, 'path'),
          content: requiredString(args, 'content'),
          mode: optionalString(args, 'mode') as 'write' | 'append' | 'overwrite' | undefined,
          createDirs: optionalBoolean(args, 'createDirs'),
        };
      },
      execute(input) {
        return runMemphisFsWrite(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_fs_ops',
      description: 'Filesystem operations: copy, move, delete, mkdir, stat',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['copy', 'move', 'delete', 'mkdir', 'stat'] },
          source: { type: 'string' },
          destination: { type: 'string' },
          recursive: { type: 'boolean' },
        },
        required: ['operation', 'source'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          operation: requiredString(args, 'operation') as
            | 'copy'
            | 'move'
            | 'delete'
            | 'mkdir'
            | 'stat',
          source: requiredString(args, 'source'),
          destination: optionalString(args, 'destination'),
          recursive: optionalBoolean(args, 'recursive'),
        };
      },
      execute(input) {
        return runMemphisFsOps(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_web_search',
      description: 'Search the web via DuckDuckGo',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (1-10)' },
        },
        required: ['query'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalNumber(args, 'limit'),
        };
      },
      async execute(input) {
        return runMemphisWebSearch(input);
      },
    }),
    buildTool({
      name: 'memphis_brave_search',
      description: 'Search the web via Brave Search API',
      inputSchema: buildRegistryInputJsonSchema('memphis_brave_search', {
        propertyDescriptions: {
          query: 'Search query',
          limit: 'Max results (1-20)',
          country: 'ISO 3166-1 alpha-2 country code',
          search_lang: 'ISO 639-1 language code',
        },
      }),
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalIntegerInRange(args, 'limit', 1, 20),
          country: optionalStringLength(args, 'country', 2),
          search_lang: optionalStringLength(args, 'search_lang', 2),
        };
      },
      async execute(input) {
        return runMemphisBraveSearch(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_media_ingest',
      description: 'Ingest a media file (audio/image) — transcribe + describe + write to chains',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to media file' },
          type: {
            type: 'string',
            enum: ['audio', 'image', 'video', 'auto'],
            description: 'Override auto-detection',
          },
          dryRun: { type: 'boolean', description: 'Skip chain writes' },
        },
        required: ['path'],
      },
      isReadOnly: false,
      isConcurrencySafe: false,
      validateInput(args) {
        return {
          path: requiredString(args, 'path'),
          type: optionalString(args, 'type') as 'audio' | 'image' | 'video' | 'auto' | undefined,
          dryRun: optionalBoolean(args, 'dryRun'),
        };
      },
      async execute(input) {
        return runMemphisMediaIngest(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_package',
      description: 'Package manager operations (npm, cargo, apt, pip)',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'string', enum: ['npm', 'cargo', 'apt', 'pip'] },
          action: { type: 'string', enum: ['install', 'remove', 'list', 'search'] },
          packages: { type: 'array', items: { type: 'string' } },
          global: { type: 'boolean' },
        },
        required: ['manager', 'action'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          manager: requiredString(args, 'manager') as 'npm' | 'cargo' | 'apt' | 'pip',
          action: requiredString(args, 'action') as 'install' | 'remove' | 'list' | 'search',
          packages: optionalStringArray(args, 'packages'),
          global: optionalBoolean(args, 'global'),
        };
      },
      execute(input) {
        return runMemphisPackage(input);
      },
    }),
    buildTool({
      name: 'memphis_db',
      description: 'Query and manage SQLite databases',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['query', 'execute', 'tables', 'schema'] },
          sql: { type: 'string' },
          database: { type: 'string' },
        },
        required: ['action'],
      },
      validateInput(args) {
        return {
          action: requiredString(args, 'action') as 'query' | 'execute' | 'tables' | 'schema',
          sql: optionalString(args, 'sql'),
          database: optionalString(args, 'database'),
        };
      },
      execute(input) {
        return runMemphisDb(input);
      },
    }),

    // ── Build/deploy tools ──────────────────────────────────────────

    buildTool({
      name: 'memphis_build',
      description: 'Auto-detect project type and run build',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Subdirectory to build' },
          command: { type: 'string', description: 'Override build command' },
          profile: { type: 'string', enum: ['debug', 'release'] },
        },
      },
      isDestructive: false,
      validateInput(args) {
        return {
          project: optionalString(args, 'project'),
          command: optionalString(args, 'command'),
          profile: optionalString(args, 'profile') as 'debug' | 'release' | undefined,
        };
      },
      execute(input) {
        return runMemphisBuild(input);
      },
    }),
    buildTool({
      name: 'memphis_health_check',
      description: 'HTTP health checks against targets',
      inputSchema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                timeout: { type: 'number' },
                expectedStatus: { type: 'number' },
              },
              required: ['url'],
            },
          },
        },
        required: ['targets'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        const targets = args.targets;
        if (!Array.isArray(targets)) {
          throw new AppError('VALIDATION_ERROR', 'targets must be an array', 400);
        }
        return {
          targets: targets as Array<{ url: string; timeout?: number; expectedStatus?: number }>,
        };
      },
      async execute(input) {
        return runMemphisHealthCheck(input);
      },
    }),
    // ─────────────────────────────────────────────────────────────────
    // S1 (sprint 2026-04-26): wire 7 tools that lived only as MCP tools.
    // Each thin-wraps the existing `runMemphis*` function from src/mcp/tools/.
    // The runtime path (TUI / Telegram / chat / CLI) now sees them too.
    //
    // Design note: keep these as JSON.stringify(returnValue) — the runtime
    // contract for `execute(input): Promise<string>` requires a string, and
    // the MCP helpers return structured objects.
    // ─────────────────────────────────────────────────────────────────
  ];
}
