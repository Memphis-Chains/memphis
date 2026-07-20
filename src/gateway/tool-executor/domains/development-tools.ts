import { runMemphisCodeRead } from '../../../mcp/tools/code-read.js';
import { runMemphisDeploy } from '../../../mcp/tools/deploy.js';
import { runMemphisGit } from '../../../mcp/tools/git.js';
import { runMemphisGlob } from '../../../mcp/tools/glob.js';
import { runMemphisGrep } from '../../../mcp/tools/grep.js';
import { runMemphisTest } from '../../../mcp/tools/test-run.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  optionalIntegerInRange,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requiredString,
} from '../input-normalization.js';

export function createDevelopmentRuntimeTools(): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_code_read',
      description: 'Read files inside ~/memphis/ (whitelisted, read-only)',
      inputSchema: buildRegistryInputJsonSchema('memphis_code_read', {
        propertyDescriptions: {
          path: 'Absolute or ~-relative path inside ~/memphis/',
          startLine: 'Start line (1-indexed, inclusive)',
          endLine: 'End line (1-indexed, inclusive)',
          limit: 'Max lines to return (default 2000, max 2000)',
        },
      }),
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          path: requiredString(args, 'path'),
          startLine: optionalIntegerInRange(args, 'startLine', 1),
          endLine: optionalIntegerInRange(args, 'endLine', 1),
          limit: optionalIntegerInRange(args, 'limit', 1, 2000),
        };
      },
      execute(input) {
        return runMemphisCodeRead(input);
      },
    }),
    buildTool({
      name: 'memphis_grep',
      description: 'Search code using regex patterns (ripgrep or grep)',
      inputSchema: buildRegistryInputJsonSchema('memphis_grep', {
        propertyDescriptions: {
          pattern: 'Regex pattern to search for',
          path: 'Subdirectory to search within (relative to project root)',
          glob: 'Glob to filter files (e.g. "*.ts", "*.rs")',
          limit: 'Max results (default 50, max 200)',
          context: 'Lines of context around matches',
          ignoreCase: 'Case-insensitive search',
        },
      }),
      isReadOnly: true,
      isDestructive: false,
      validateInput(args) {
        return {
          pattern: requiredString(args, 'pattern'),
          path: optionalString(args, 'path'),
          glob: optionalString(args, 'glob'),
          limit: optionalIntegerInRange(args, 'limit', 1, 200),
          context: optionalIntegerInRange(args, 'context', 0),
          ignoreCase: args.ignoreCase === true,
        };
      },
      execute(input) {
        return runMemphisGrep(input);
      },
    }),
    buildTool({
      name: 'memphis_glob',
      description: 'Find files by glob pattern (fd or find)',
      inputSchema: buildRegistryInputJsonSchema('memphis_glob', {
        propertyDescriptions: {
          pattern: 'Glob pattern (e.g. "**/*.ts", "*.json")',
          path: 'Subdirectory to search within (relative to project root)',
          limit: 'Max results (default 100, max 500)',
        },
      }),
      isReadOnly: true,
      isDestructive: false,
      validateInput(args) {
        return {
          pattern: requiredString(args, 'pattern'),
          path: optionalString(args, 'path'),
          limit: optionalIntegerInRange(args, 'limit', 1, 500),
        };
      },
      execute(input) {
        return runMemphisGlob(input);
      },
    }),
    buildTool({
      name: 'memphis_git',
      description:
        'Git operations — status, log, diff, add, commit, push (read ops: tier 1, write ops: tier 2)',
      inputSchema: {
        type: 'object',
        properties: {
          subcommand: {
            type: 'string',
            description: 'Git subcommand (status, log, diff, add, commit, push, etc.)',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments for the subcommand',
          },
        },
        required: ['subcommand'],
      },
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          subcommand: requiredString(args, 'subcommand'),
          args: optionalStringArray(args, 'args'),
        };
      },
      execute(input) {
        return runMemphisGit(input);
      },
    }),
    buildTool({
      name: 'memphis_test',
      description: 'Run project tests (ts, rust, lint, typecheck, or all)',
      inputSchema: {
        type: 'object',
        properties: {
          suite: {
            type: 'string',
            description: 'Test suite: "ts" | "rust" | "lint" | "typecheck" | "all" (default: ts)',
          },
          filter: { type: 'string', description: 'Filter pattern for test files (vitest only)' },
        },
      },
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          suite: optionalString(args, 'suite'),
          filter: optionalString(args, 'filter'),
        };
      },
      execute(input) {
        return runMemphisTest(input);
      },
    }),
    buildTool({
      name: 'memphis_deploy',
      description: 'Run deploy, health, and rollback workflows with snapshots and health checks',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: run | health | rollback' },
          profile: {
            type: 'string',
            description: 'Deploy profile: local-service | build-only | custom',
          },
          buildCommand: { type: 'string', description: 'Build command override' },
          deployCommand: { type: 'string', description: 'Custom deploy command override' },
          healthUrl: { type: 'string', description: 'HTTP health endpoint override' },
          testSuite: {
            type: 'string',
            description: 'Test suite: ts | rust | lint | typecheck | all',
          },
          deep: { type: 'boolean', description: 'Run deeper doctor checks' },
          dryRun: {
            type: 'boolean',
            description: 'Preview the deploy plan without mutating state',
          },
          rollbackIndex: {
            type: 'number',
            description: 'Snapshot index for rollback (1 = latest)',
          },
        },
      },
      isReadOnly: false,
      isDestructive: true,
      validateInput(args) {
        return {
          action: optionalString(args, 'action') as 'run' | 'health' | 'rollback' | undefined,
          profile: optionalString(args, 'profile') as
            | 'local-service'
            | 'build-only'
            | 'custom'
            | undefined,
          buildCommand: optionalString(args, 'buildCommand'),
          deployCommand: optionalString(args, 'deployCommand'),
          healthUrl: optionalString(args, 'healthUrl'),
          testSuite: optionalString(args, 'testSuite') as
            | 'ts'
            | 'rust'
            | 'lint'
            | 'typecheck'
            | 'all'
            | undefined,
          deep: args.deep === true,
          dryRun: args.dryRun === true,
          rollbackIndex: optionalNumber(args, 'rollbackIndex'),
        };
      },
      async execute(input) {
        return runMemphisDeploy(input);
      },
    }),
  ];
}
