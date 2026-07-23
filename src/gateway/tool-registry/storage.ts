import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const STORAGE_TOOLS: Record<string, ToolMeta> = {
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
      "Direct read over a chain's block log with simple filters (blockType, substring `contains`, tag match). Returns raw block envelopes including hash + index + signature so the operator can audit chain integrity or pull a specific block by content. Pagination via `offset` + `limit`. Gated behind `experimental-tools` because the surface is intended for diagnostic introspection — for normal recall use memphis_recall (semantic) or memphis_search (literal).",
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
        description: "Match a single tag from the block's tags array.",
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
  memphis_chain_verify: {
    name: 'memphis_chain_verify',
    tier: 0,
    capabilities: ['read'],
    description: 'Verify chain hashes, indexes, and prev-hash links before diagnosing corruption',
    inputSchema: z
      .object({
        chain: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Authoritative read-only chain verifier. Pass one canonical chain name or omit it to verify every chain. A shortened content preview is never evidence of corruption: only a failed memphis_chain_verify result may support that diagnosis.',
    cliFlags: [
      {
        name: '--chain',
        description: 'Optional chain name; omit to verify all chains.',
        takesValue: true,
      },
    ],
  },
};
