import { runMemphisDecide } from '../../../mcp/tools/decide.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { runMemphisKartograf } from '../../../mcp/tools/kartograf.js';
import { runMemphisRecall } from '../../../mcp/tools/recall.js';
import { runMemphisSearch } from '../../../mcp/tools/search.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  optionalIntegerInRange,
  optionalString,
  optionalStringArray,
  requiredString,
} from '../input-normalization.js';

export type MemoryRuntimeToolDeps = {
  rawEnv?: NodeJS.ProcessEnv;
  surface?: string;
  conversationId?: string;
  sessionId?: string;
  turnId?: string;
};

export function createMemoryRuntimeTools(
  deps: MemoryRuntimeToolDeps,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_journal',
      description:
        'Save important context or observations to the journal chain for later recall. This is NOT a channel for replying to the user — always produce a normal text reply after any tool calls.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to journal' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['content'],
      },
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          content: requiredString(args, 'content'),
          tags: optionalStringArray(args, 'tags'),
        };
      },
      async execute(input) {
        // Thread caller surface + conversation binding into the
        // journal write so consent resolution honors the active turn's
        // surface policy (MEMPHIS_SURFACE_<SURFACE>_DEFAULT_CONSENT
        // overrides apply) AND the trajectory exporter groups
        // tool-emitted writes under the same session as memory-client
        // writes. Falls through to 'mcp' default and no binding when
        // the executor was constructed without the turn context (raw
        // MCP server case).
        return runMemphisJournal({
          ...input,
          surface: deps.surface,
          conversationId: deps.conversationId,
          sessionId: deps.sessionId,
          turnId: deps.turnId,
        });
      },
    }),
    buildTool({
      name: 'memphis_kartograf',
      description:
        'Run Kartograf inference on text — returns 256-d embedding + zone classification (12 chains). Requires installed checkpoint + MEMPHIS_KARTOGRAF_ENABLE=1. Returns structured error if either is missing.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to classify (1-8192 chars)' },
          top_k_zones: {
            type: 'number',
            description: 'Return only top-K zones (1-12). Omit for full distribution.',
          },
        },
        required: ['query'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        const q = (args as { query?: unknown }).query;
        if (typeof q !== 'string' || q.length === 0) {
          throw new Error('memphis_kartograf: query (string, 1-8192 chars) is required');
        }
        if (q.length > 8192) {
          throw new Error('memphis_kartograf: query exceeds 8192-char limit');
        }
        const topKRaw = (args as { top_k_zones?: unknown }).top_k_zones;
        const top_k_zones =
          typeof topKRaw === 'number' && Number.isFinite(topKRaw) && topKRaw >= 1 && topKRaw <= 12
            ? Math.floor(topKRaw)
            : undefined;
        return { query: q, ...(top_k_zones !== undefined ? { top_k_zones } : {}) };
      },
      execute(input) {
        return runMemphisKartograf(input, deps.rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_recall',
      description: 'Semantic search across Memphis memory chains',
      inputSchema: buildRegistryInputJsonSchema('memphis_recall', {
        propertyDescriptions: {
          query: 'Search query',
          limit: 'Max results (1-50)',
        },
      }),
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalIntegerInRange(args, 'limit', 1, 50) ?? 5,
        };
      },
      execute(input) {
        return runMemphisRecall(input);
      },
    }),
    buildTool({
      name: 'memphis_search',
      description: 'Exact phrase search across indexed Memphis memory',
      inputSchema: buildRegistryInputJsonSchema('memphis_search', {
        propertyDescriptions: {
          query: 'Exact phrase to search for',
          limit: 'Max results (1-50)',
          chain: 'Optional chain filter',
        },
      }),
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          query: requiredString(args, 'query'),
          limit: optionalIntegerInRange(args, 'limit', 1, 50) ?? 5,
          chain: optionalString(args, 'chain'),
        };
      },
      execute(input) {
        return runMemphisSearch(input);
      },
    }),
    buildTool({
      name: 'memphis_decide',
      description: 'Record a decision with context',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          choice: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['title', 'choice'],
      },
      validateInput(args) {
        return {
          title: requiredString(args, 'title'),
          choice: requiredString(args, 'choice'),
          context: optionalString(args, 'context'),
        };
      },
      async execute(input) {
        return runMemphisDecide(input);
      },
    }),
  ];
}
