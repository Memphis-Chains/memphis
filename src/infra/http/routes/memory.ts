import { getChainPath } from '../../../config/paths.js';
import { resolveSurfacePolicy } from '../../../gateway/surface-policy.js';
import { runMemphisRecall, type RecallMode } from '../../../mcp/tools/recall.js';
import { writeSecurityAudit, type SecurityAuditEvent } from '../../logging/security-audit.js';
import { storeDurableMemory, type DurableMemoryStoreResult } from '../../memory/durable-memory.js';
import { searchExactMemory, type ExactSearchOutput } from '../../memory/exact-search.js';
import { embedSearch } from '../../storage/rust-embed-adapter.js';
import { resolveSafeChildPath } from '../path-validation.js';

const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

type MemoryRouteRequest = {
  body: unknown;
  ip?: string;
};

type MemoryRouteReply = {
  status: (code: number) => { send: (payload: unknown) => unknown };
};

type MemoryRouteApp = {
  post: (
    path: string,
    handler: (request: MemoryRouteRequest, reply: MemoryRouteReply) => Promise<unknown>,
  ) => void;
};

type SearchResult = {
  query: string;
  count: number;
  mode: RecallMode;
  degraded: boolean;
  warning?: string;
  hits: Array<{
    id: string;
    score: number;
    text_preview: string;
    tags: string[];
    chain?: string;
    sourceKey?: string;
  }>;
};
type ExactSearchResult = ExactSearchOutput;

export type MemoryRouteDeps = {
  store: (
    input: {
      content: string;
      tags?: string[];
      chain?: string;
      source?: string;
      turnId?: string;
      consent?: 'exportable' | 'local-only' | 'anonymized';
    },
    rawEnv?: NodeJS.ProcessEnv,
  ) => Promise<DurableMemoryStoreResult>;
  search: (
    query: string,
    topK?: number,
    rawEnv?: NodeJS.ProcessEnv,
    tags?: string[],
  ) => ReturnType<typeof embedSearch>;
  exactSearch?: (
    query: string,
    limit?: number,
    rawEnv?: NodeJS.ProcessEnv,
    chain?: string,
  ) => ExactSearchResult;
  audit: (event: SecurityAuditEvent, rawEnv?: NodeJS.ProcessEnv) => void;
  isSafeChainName: (chain: unknown) => chain is string;
};

const defaultDeps: MemoryRouteDeps = {
  store: (input, rawEnv = process.env) => {
    // Honor MEMPHIS_SURFACE_<surface>_DEFAULT_CONSENT override:
    // resolve the 'http' surface policy (service class) and fall back to
    // its defaultConsent when the caller didn't pass an explicit value.
    // Caller-provided consent always wins.
    const surfacePolicy = resolveSurfacePolicy('http', rawEnv);
    return storeDurableMemory({
      content: input.content,
      tags: input.tags,
      chain: input.chain,
      source: input.source,
      turnId: input.turnId,
      consent: input.consent ?? surfacePolicy.defaultConsent,
    });
  },
  search: embedSearch,
  exactSearch: searchExactMemory,
  audit: writeSecurityAudit,
  isSafeChainName,
};

function parseJournalBody(
  body: unknown,
): { content: string; tags: string[]; chain: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'content required' };
  }

  const raw = body as Record<string, unknown>;
  const content = raw.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { error: 'content required' };
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const chain =
    typeof raw.chain === 'string' && raw.chain.trim().length > 0 ? raw.chain : 'journal';

  return { content, tags, chain };
}

function parseRecallBody(
  body: unknown,
):
  | { query: string; limit: number; userId?: string; tags?: string[]; chain?: string }
  | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'query required' };
  }

  const raw = body as Record<string, unknown>;
  const query = raw.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { error: 'query required' };
  }

  const limit = raw.limit === undefined ? 10 : Number(raw.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return { error: 'limit must be between 1 and 100' };
  }

  const userId =
    typeof raw.userId === 'string' && raw.userId.trim().length > 0 ? raw.userId : undefined;

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;

  const chain =
    typeof raw.chain === 'string' && raw.chain.trim().length > 0 ? raw.chain.trim() : undefined;

  return {
    query,
    limit,
    userId,
    tags: tags && tags.length > 0 ? tags : undefined,
    chain,
  };
}

function filterResultsForUser(
  hits: SearchResult['hits'],
  limit: number,
  userId?: string,
): SearchResult['hits'] {
  if (!userId) return hits;
  const userTag = `[${userId}]`;
  return hits.filter((hit) => hit.text_preview.includes(userTag)).slice(0, limit);
}

function filterExactResultsForUser(
  hits: ExactSearchOutput['hits'],
  limit: number,
  userId?: string,
): ExactSearchOutput['hits'] {
  if (!userId) return hits.slice(0, limit);
  const userTag = `[${userId}]`;
  return hits.filter((hit) => hit.content.includes(userTag)).slice(0, limit);
}

export function registerMemoryRoutes(
  app: MemoryRouteApp,
  deps: MemoryRouteDeps = defaultDeps,
): void {
  app.post('/api/journal', async (request, reply) => {
    const parsed = parseJournalBody(request.body);
    if ('error' in parsed) {
      return reply.status(400).send({ ok: false, error: parsed.error });
    }

    const { content, tags, chain } = parsed;
    if (!deps.isSafeChainName(chain)) {
      deps.audit(
        {
          action: 'journal.append',
          status: 'blocked',
          ip: request.ip,
          route: '/api/journal',
          details: { reason: 'invalid_chain_name', chain },
        },
        process.env,
      );
      return reply.status(400).send({ ok: false, error: 'invalid chain name' });
    }

    try {
      // HTTP /api/journal is an out-of-turn operator/agent write. No
      // request-scoped turnId is propagated yet (turn binding on the
      // HTTP chat path is the scope of N9/exporter, not N8). Consent
      // defaults via deps.store to 'exportable' for service surface.
      const result = await deps.store(
        { content, tags, chain, source: 'http-api' },
        process.env,
      );
      deps.audit(
        {
          action: 'journal.append',
          status: 'allowed',
          ip: request.ip,
          route: '/api/journal',
          details: { chain, index: result.index },
        },
        process.env,
      );
      return {
        ok: true,
        index: result.index,
        hash: result.hash,
        memoryId: result.memoryId,
        indexed: result.indexed,
      };
    } catch (error) {
      deps.audit(
        {
          action: 'journal.append',
          status: 'error',
          ip: request.ip,
          route: '/api/journal',
          details: {
            chain,
            message: error instanceof Error ? error.message : 'journal_append_failed',
          },
        },
        process.env,
      );
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'journal_append_failed',
      });
    }
  });

  app.post('/api/recall', async (request, reply) => {
    const parsed = parseRecallBody(request.body);
    if ('error' in parsed) {
      deps.audit(
        {
          action: 'recall.query',
          status: 'blocked',
          ip: request.ip,
          route: '/api/recall',
          details: { reason: 'invalid_payload' },
        },
        process.env,
      );
      return reply.status(400).send({ ok: false, error: parsed.error });
    }

    const { query, limit, userId, tags, chain } = parsed;
    try {
      const searchLimit = userId ? Math.min(limit * 3, 100) : limit;
      const recall = runMemphisRecall(
        { query, limit: searchLimit, tags, chain },
        {
          search: deps.search,
          exactSearch: deps.exactSearch ?? searchExactMemory,
          rawEnv: process.env,
        },
      );
      const filteredHits = filterResultsForUser(
        recall.results.map((hit, index) => ({
          id: hit.sourceKey ?? `${hit.chain ?? 'memory'}:${index}`,
          score: hit.score,
          text_preview: hit.content,
          tags: hit.tags,
          chain: hit.chain,
          sourceKey: hit.sourceKey,
        })),
        limit,
        userId,
      );
      const payload: SearchResult = {
        query,
        mode: recall.mode,
        degraded: recall.degraded,
        warning: recall.warning,
        hits: filteredHits,
        count: filteredHits.length,
      };

      deps.audit(
        {
          action: 'recall.query',
          status: 'allowed',
          ip: request.ip,
          route: '/api/recall',
          details: {
            limit,
            userId: userId ?? null,
            tags: tags ?? null,
            chain: chain ?? null,
            mode: payload.mode,
            degraded: payload.degraded,
            results: payload.count,
          },
        },
        process.env,
      );
      if (payload.degraded) {
        deps.audit(
          {
            action: 'recall.query',
            status: 'allowed',
            ip: request.ip,
            route: '/api/recall',
            details: {
              reason: 'degraded_recall_fallback',
              mode: payload.mode,
              warning: payload.warning ?? null,
            },
          },
          process.env,
        );
      }
      return { ok: true, results: payload };
    } catch (error) {
      deps.audit(
        {
          action: 'recall.query',
          status: 'error',
          ip: request.ip,
          route: '/api/recall',
          details: { message: error instanceof Error ? error.message : 'recall_failed' },
        },
        process.env,
      );
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'recall_failed',
      });
    }
  });

  app.post('/api/search', async (request, reply) => {
    const parsed = parseRecallBody(request.body);
    if ('error' in parsed) {
      deps.audit(
        {
          action: 'search.query',
          status: 'blocked',
          ip: request.ip,
          route: '/api/search',
          details: { reason: 'invalid_payload' },
        },
        process.env,
      );
      return reply.status(400).send({ ok: false, error: parsed.error });
    }

    const { query, limit, userId, chain } = parsed;
    try {
      const exactSearch = deps.exactSearch ?? searchExactMemory;
      const payload = exactSearch(
        query,
        userId ? Math.min(limit * 3, 100) : limit,
        process.env,
        chain,
      );
      const filteredHits = filterExactResultsForUser(payload.hits, limit, userId);
      const filteredPayload: ExactSearchResult = {
        ...payload,
        hits: filteredHits,
        count: filteredHits.length,
      };

      deps.audit(
        {
          action: 'search.query',
          status: 'allowed',
          ip: request.ip,
          route: '/api/search',
          details: {
            limit,
            userId: userId ?? null,
            chain: chain ?? null,
            results: filteredPayload.count,
          },
        },
        process.env,
      );
      return { ok: true, results: filteredPayload };
    } catch (error) {
      deps.audit(
        {
          action: 'search.query',
          status: 'error',
          ip: request.ip,
          route: '/api/search',
          details: { message: error instanceof Error ? error.message : 'search_failed' },
        },
        process.env,
      );
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'search_failed',
      });
    }
  });
}

function isSafeChainName(chain: unknown): chain is string {
  if (typeof chain !== 'string') {
    return false;
  }

  if (!SAFE_CHAIN_NAME.test(chain.trim())) {
    return false;
  }

  try {
    resolveSafeChildPath(getChainPath(), chain);
    return true;
  } catch {
    return false;
  }
}
