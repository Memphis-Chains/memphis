import { runMemphisClassify } from '../../../mcp/tools/classify.js';
import { runMemphisDecide } from '../../../mcp/tools/decide.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { runMemphisKartograf } from '../../../mcp/tools/kartograf.js';
import { runMemphisRecall } from '../../../mcp/tools/recall.js';
import { runMemphisSearch } from '../../../mcp/tools/search.js';
import { runMemphisWalletSign } from '../../../mcp/tools/wallet-sign.js';
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

export function createMemoryRuntimeTools(deps: MemoryRuntimeToolDeps): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_journal',
      description:
        'Save important context or observations to the journal chain for later recall. This is NOT a channel for replying to the user — always produce a normal text reply after any tool calls.',
      inputSchema: buildRegistryInputJsonSchema('memphis_journal', {
        propertyDescriptions: {
          content: 'Content to journal',
          tags: 'Optional tags',
        },
      }),
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          content: requiredString(args, 'content'),
          tags: optionalStringArray(args, 'tags'),
          // The chain travels with the call. It used to be dropped here,
          // so the gateway path silently wrote to the default chain while
          // the MCP path honoured the name — the same call, two different
          // results. The tool validates the name against
          // `JOURNAL_TARGET_CHAINS` at its own boundary.
          chain: optionalString(args, 'chain'),
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
      inputSchema: buildRegistryInputJsonSchema('memphis_kartograf', {
        propertyDescriptions: {
          query: 'Text to classify (1-8192 chars)',
          top_k_zones: 'Return only top-K zones (1-12). Omit for full distribution.',
        },
      }),
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
      name: 'memphis_classify',
      description:
        'Advisory typed decision via local BASAL with validated probabilities. auto only reports caller-threshold eligibility; it grants no action permissions or error-rate guarantee. Classes are supplied per request. Revalidate calibration for each model/backend. Historical CPU calls took 70-140 seconds; unavailable services return a structured error.',
      inputSchema: buildRegistryInputJsonSchema('memphis_classify', {
        propertyDescriptions: {
          state: 'Text to classify (1-32000 chars)',
          question: 'What to decide about it, in plain language',
          criteria:
            'Options as {key: description} pairs, or an array of 2-10 labels. Score object keys must be ordinal positions 0..n-1; score arrays preserve level order.',
          threshold:
            'Advisory threshold from 0 to 1; explicit policy overrides service discovery, fallback 0.93',
          orders: '1 = one pass (fast, order-sensitive). 2 = averaged over both option orders.',
        },
      }),
      // Not concurrency-safe: a call holds the single-threaded CPU model for
      // minutes. Running several at once starves the host and makes every
      // one of them slower.
      isConcurrencySafe: false,
      isReadOnly: true,
      validateInput(args) {
        const a = args as {
          state?: unknown;
          question?: unknown;
          criteria?: unknown;
          type?: unknown;
          threshold?: unknown;
          orders?: unknown;
        };
        if (typeof a.state !== 'string' || a.state.trim().length === 0) {
          throw new Error('memphis_classify: state (non-empty string) is required');
        }
        if (typeof a.question !== 'string' || a.question.trim().length === 0) {
          throw new Error('memphis_classify: question (non-empty string) is required');
        }
        const rawCriteria: unknown = a.criteria;
        const isArrayCriteria = Array.isArray(rawCriteria);
        const rawMap: Record<string, unknown> =
          !isArrayCriteria && rawCriteria && typeof rawCriteria === 'object'
            ? (rawCriteria as Record<string, unknown>)
            : {};
        const asList: string[] = isArrayCriteria
          ? (rawCriteria as unknown[]).filter(
              (c): c is string => typeof c === 'string' && c.trim().length > 0,
            )
          : Object.keys(rawMap).filter((k) => k.trim().length > 0);
        if (asList.length < 2) {
          throw new Error('memphis_classify: criteria needs at least two options');
        }
        if (asList.length > 10) {
          throw new Error(`memphis_classify: at most 10 options, got ${asList.length}`);
        }
        const criteria: Record<string, string> | string[] = isArrayCriteria
          ? asList
          : Object.fromEntries(asList.map((k) => [k, String(rawMap[k])]));
        const qType: 'choice' | 'noul' | 'score' | undefined =
          a.type === 'choice' || a.type === 'noul' || a.type === 'score' ? a.type : undefined;
        const orders: 1 | 2 | undefined = a.orders === 1 || a.orders === 2 ? a.orders : undefined;
        return {
          state: a.state,
          question: a.question,
          criteria,
          ...(qType !== undefined ? { type: qType } : {}),
          ...(typeof a.threshold === 'number' ? { threshold: a.threshold } : {}),
          ...(orders !== undefined ? { orders } : {}),
        };
      },
      execute(input) {
        return runMemphisClassify(input, deps.rawEnv);
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
      inputSchema: buildRegistryInputJsonSchema('memphis_decide'),
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
    buildTool({
      name: 'memphis_wallet_sign',
      description:
        'Sign a Solana transaction message with an Ed25519 seed held in the vault. The private key is decrypted inside a callback and never returned — only the base58 public key, the 64-byte signature, and a SHA-256 of the signed message.',
      inputSchema: buildRegistryInputJsonSchema('memphis_wallet_sign', {
        propertyDescriptions: {
          keyName: 'Vault key holding a base64 32-byte Ed25519 seed',
          message: 'Base64 transaction message bytes to sign',
          label: 'Operator label recorded in the audit entry',
        },
      }),
      // Signing is not concurrency-safe in spirit: two simultaneous
      // signatures produce two audit entries racing on the chain append,
      // and a caller that signs in parallel is usually not asking a
      // question but firing a batch without reading the results.
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        return {
          keyName: requiredString(args, 'keyName'),
          message: requiredString(args, 'message'),
          label: optionalString(args, 'label'),
        };
      },
      execute(input) {
        return runMemphisWalletSign(input);
      },
    }),
  ];
}
