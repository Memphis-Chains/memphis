import { getChainPath } from '../../../config/paths.js';
import { writeSecurityAudit, type SecurityAuditEvent } from '../../logging/security-audit.js';
import { appendBlock } from '../../storage/chain-adapter.js';
import { embedSearch, type EmbedSearchHit } from '../../storage/rust-embed-adapter.js';
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

type AppendResult = Awaited<ReturnType<typeof appendBlock>>;
type SearchResult = ReturnType<typeof embedSearch>;

export type MemoryRouteDeps = {
  append: (
    chain: string,
    data: Record<string, unknown>,
    rawEnv?: NodeJS.ProcessEnv,
  ) => Promise<AppendResult>;
  search: (query: string, topK?: number, rawEnv?: NodeJS.ProcessEnv) => SearchResult;
  audit: (event: SecurityAuditEvent, rawEnv?: NodeJS.ProcessEnv) => void;
  isSafeChainName: (chain: unknown) => chain is string;
};

const defaultDeps: MemoryRouteDeps = {
  append: appendBlock,
  search: embedSearch,
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
): { query: string; limit: number; userId?: string } | { error: string } {
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
  return { query, limit, userId };
}

function filterResultsForUser(
  hits: EmbedSearchHit[],
  limit: number,
  userId?: string,
): EmbedSearchHit[] {
  if (!userId) return hits;
  const userTag = `[${userId}]`;
  return hits.filter((hit) => hit.text_preview.includes(userTag)).slice(0, limit);
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
      const result = await deps.append(chain, { type: 'journal', content, tags }, process.env);
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
      return { ok: true, index: result.index, hash: result.hash };
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
      return reply.status(400).send({ ok: false, error: parsed.error });
    }

    const { query, limit, userId } = parsed;
    try {
      const searchLimit = userId ? Math.min(limit * 3, 100) : limit;
      const results = deps.search(query, searchLimit, process.env);
      const filteredHits = filterResultsForUser(results.hits, limit, userId);
      const payload: SearchResult = {
        ...results,
        hits: filteredHits,
        count: filteredHits.length,
      };

      deps.audit(
        {
          action: 'recall.query',
          status: 'allowed',
          ip: request.ip,
          route: '/api/recall',
          details: { limit, userId: userId ?? null, results: payload.count },
        },
        process.env,
      );
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
