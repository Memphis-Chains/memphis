/**
 * Trajectory exporter — Y1 Q1 N9 (PR C).
 *
 * Reads chain blocks via the existing chain-query layer, maps each into
 * a TrajectoryEvent per the v1 schema contract in `./schema.ts`, groups
 * events by session (`turnId` binding from N8) into a Trajectory, and
 * optionally writes to JSONL.
 *
 * Grandfathering rules (per docs/dev/TRAJECTORY-EXPORT-V1.md §Consent
 * handling): blocks written before N8 have no `data.turn_id` /
 * `data.consent`. Those are mapped as:
 *   - turnId: null   (unlinked event — system/scheduler/legacy)
 *   - consent: 'exportable' (legacy default; matches write-side grand-
 *     fathering in `storeDurableMemory.resolveConsent()`)
 *
 * Anonymized consent honored by replacing `payload.content` with the
 * SHA-256 hex of the original content; tags preserved. Smart PII
 * scrubbing (name replacement etc.) is explicitly v2.
 *
 * Consent filtering (default): only 'exportable' events are returned.
 * Callers that need more pass `consent: 'all'` AND set
 * MEMPHIS_EXPORT_CONFIRM=1 (the exporter refuses 'all' without the
 * confirm env so a mis-click can't leak local-only data).
 */

import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  Trajectory,
  type ConsentLevelT,
  type TrajectoryEventKindT,
  type TrajectoryEventT,
  type TrajectoryIntegrityT,
  type TrajectorySurfaceT,
  type TrajectoryT,
} from './schema.js';
import { runMemphisChainQuery } from '../mcp/tools/chain-query.js';
import type { Block } from '../memory/chain.js';

/**
 * 8 live operator-content chains. Pulled as one set so the exporter
 * can issue a chain_query per chain without re-hardcoding the list
 * each time. Matches the canonical catalog in
 * `src/memory/chain-catalog.ts`; `insights` + `soul` are included
 * even though they're richer than durable memory to match the
 * trajectory-v1 spec which groups all chain-write events uniformly.
 */
export const EXPORTABLE_CHAINS = [
  'journal',
  'decisions',
  'reflections',
  'cases',
  'patterns',
  'system',
  'collective',
  'proactive',
  'insights',
  'soul',
] as const;

export type ExportableChain = (typeof EXPORTABLE_CHAINS)[number];

export interface ExportTrajectoriesInput {
  /**
   * Consent filter. 'exportable' = default; 'all' requires explicit
   * confirmation env var `MEMPHIS_EXPORT_CONFIRM=1` and exports every
   * non-anonymized block regardless of consent level. 'anonymized'
   * exports only anonymized + exportable (never raw local-only).
   */
  consent?: ConsentLevelT | 'all';
  /** ISO-8601 lower bound on block timestamp. */
  sinceIso?: string;
  /**
   * Subset of chains to include. Defaults to all 10 live chains.
   */
  chains?: readonly string[];
  /**
   * Max blocks to fetch per chain. The limit is applied per-chain,
   * after timestamp filtering, to keep memory usage predictable on
   * operators with very long chains. Default 5000.
   */
  limitPerChain?: number;
  /** Override the chain-query driver (test seam). */
  query?: typeof runMemphisChainQuery;
  /** Environment (for MEMPHIS_EXPORT_CONFIRM + agent identity). */
  rawEnv?: NodeJS.ProcessEnv;
}

export interface ExportTrajectoriesOutput {
  trajectories: TrajectoryT[];
  /**
   * Events that failed schema validation. Always empty in production —
   * this is a safety net against malformed chain data. Populated when
   * a block exists on-chain but couldn't be mapped to TrajectoryEvent.
   */
  skipped: Array<{ chain: string; blockIndex: number; reason: string }>;
  /** Summary counters surfaced to operator + CLI JSON output. */
  summary: {
    totalEvents: number;
    includedEvents: number;
    filteredByConsent: number;
    anonymizedEvents: number;
    sessionCount: number;
    chainCount: number;
  };
}

const DEFAULT_LIMIT = 5000;

/**
 * Single-pass block → TrajectoryEvent mapping. Errors surface as
 * `null` so the caller can accumulate `skipped` reasons.
 */
export function mapBlockToEvent(
  block: Block,
  chain: string,
  surface: TrajectorySurfaceT,
): { event: TrajectoryEventT | null; reason?: string } {
  if (
    typeof block.index !== 'number' ||
    typeof block.timestamp !== 'string' ||
    typeof block.hash !== 'string' ||
    !block.data
  ) {
    return { event: null, reason: 'block missing index/timestamp/hash/data' };
  }

  // Timestamp normalization: chain blocks use ISO-8601 UTC ('Z');
  // trajectory-v1 schema requires an offset-qualified datetime which
  // includes 'Z'. Pass through verbatim if it parses; otherwise tack
  // on 'Z' then validate.
  let ts = block.timestamp;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)) {
    // Defensive normalization — some legacy writes may have omitted the Z.
    ts = `${ts}Z`;
  }
  // Validate by reparse — a malformed timestamp (e.g. `not-a-date`)
  // would still propagate to `Trajectory.parse` later and invalidate
  // the whole trajectory bucket, dropping other valid events with it.
  // Reject at the source instead.
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) {
    return { event: null, reason: `invalid timestamp: ${block.timestamp}` };
  }

  const data = block.data as Record<string, unknown>;
  const turnIdRaw = data.turn_id;
  const turnId = typeof turnIdRaw === 'string' && turnIdRaw.length > 0 ? turnIdRaw : null;

  const consent: ConsentLevelT = resolveBlockConsent(data);
  const kind = resolveEventKind(data);
  const payload = buildPayload(data, consent);

  // prev_hash is BLOCK-level metadata on the chain record, not inside
  // `data` (the payload). The prior `data.prev_hash` lookup always
  // missed and fell back to all-zeros, breaking hash-chain verification
  // downstream. Schema-level `data.prev_hash` remains a fallback purely
  // in case a legacy seeder stored it there; production writers put it
  // at the block level (see NapiBlock in chain-file-io.ts).
  const blockPrev = typeof block.prev_hash === 'string' ? block.prev_hash : undefined;
  const dataPrev = typeof data.prev_hash === 'string' ? data.prev_hash : undefined;
  const prevHash = blockPrev ?? dataPrev ?? '0'.repeat(64);

  const event: TrajectoryEventT = {
    kind,
    ts,
    turnId,
    surface,
    consent,
    provenance: {
      chain,
      blockIndex: block.index,
      blockHash: block.hash,
      prevHash,
      ...(block.signer ? { signer: block.signer } : {}),
      ...(block.signature ? { signature: block.signature } : {}),
    },
    payload,
  };
  return { event };
}

function resolveBlockConsent(data: Record<string, unknown>): ConsentLevelT {
  const raw = data.consent;
  if (raw === 'exportable' || raw === 'local-only' || raw === 'anonymized') return raw;
  // Grandfathering: legacy consent-less blocks are treated as
  // exportable per trajectory-v1 spec.
  return 'exportable';
}

function resolveEventKind(data: Record<string, unknown>): TrajectoryEventKindT {
  // Map Memphis block.data.type → trajectory event kind. Conservative
  // fallback to 'chain_write' — the durable-memory spec never writes
  // an unknown type, but unknown-type blocks from future versions
  // should still export as writes rather than being dropped.
  const type = data.type;
  if (type === 'user_input') return 'user_input';
  if (type === 'tool_call') return 'tool_call';
  if (type === 'tool_result') return 'tool_result';
  if (type === 'model_response') return 'model_response';
  if (type === 'cognitive_prelude') return 'cognitive_prelude';
  if (type === 'cognitive_post') return 'cognitive_post';
  if (type === 'system' || type === 'system_event') return 'system_event';
  if (type === 'prompt_fragment') return 'prompt_fragment';
  return 'chain_write';
}

function buildPayload(data: Record<string, unknown>, consent: ConsentLevelT): Record<string, unknown> {
  const contentRaw = typeof data.content === 'string' ? data.content : '';
  const content = consent === 'anonymized' ? sha256Hex(contentRaw) : contentRaw;
  const tags = Array.isArray(data.tags) ? (data.tags as unknown[]).filter((t) => typeof t === 'string') : [];
  const source = typeof data.source === 'string' ? data.source : undefined;
  const memoryId = typeof data.memory_id === 'string' ? data.memory_id : undefined;

  const payload: Record<string, unknown> = {
    content,
    tags,
    anonymized: consent === 'anonymized',
  };
  if (source !== undefined) payload.source = source;
  if (memoryId !== undefined) payload.memory_id = memoryId;
  if (data.type !== undefined) payload.block_type = data.type;
  // Thread session-binding fields so the grouping pass can read them.
  // Writers haven't started stamping these yet (extension of N8) but
  // we're forward-compatible when they do.
  const cid = data.conversation_id ?? (data as { conversationId?: unknown }).conversationId;
  if (typeof cid === 'string' && cid.length > 0) payload.conversation_id = cid;
  const sid = data.session_id ?? (data as { sessionId?: unknown }).sessionId;
  if (typeof sid === 'string' && sid.length > 0) payload.session_id = sid;
  return payload;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function surfaceForChain(chain: string): TrajectorySurfaceT {
  // Chain-only fallback. Prefer `resolveBlockSurface(data, chain)` which
  // inspects `data.source` first — CLI reflect/insight paths write with
  // `source: 'cli.reflect'` etc. and those must not flatten to 'mcp'.
  if (chain === 'system' || chain === 'collective' || chain === 'proactive') return 'system';
  if (chain === 'insights' || chain === 'reflections' || chain === 'patterns') return 'scheduler';
  return 'mcp';
}

function resolveBlockSurface(
  data: Record<string, unknown>,
  chain: string,
): TrajectorySurfaceT {
  // Block writers stamp `data.source` with their surface (mcp, cli.*,
  // http.*, telegram, scheduler, ...). Map common prefixes onto the
  // trajectory surface enum; fall back to chain-based heuristic when
  // source is absent or doesn't match a recognized surface family.
  const raw = typeof data.source === 'string' ? data.source.toLowerCase() : '';
  if (raw.startsWith('cli.') || raw === 'terminal' || raw === 'operator') return 'cli';
  if (raw.startsWith('http.') || raw === 'http') return 'http';
  if (raw === 'telegram' || raw.startsWith('telegram.')) return 'telegram';
  if (raw === 'scheduler' || raw.startsWith('scheduler.')) return 'scheduler';
  if (raw === 'system' || raw.startsWith('system.')) return 'system';
  if (raw === 'mcp' || raw.startsWith('mcp.')) return 'mcp';
  return surfaceForChain(chain);
}

/**
 * Main exporter — returns one `Trajectory` per distinct session
 * (grouped by `turnId` prefix when sessions aren't tagged, falling
 * back to a single unbound trajectory for legacy unlinked events).
 */
export async function exportTrajectories(
  input: ExportTrajectoriesInput = {},
): Promise<ExportTrajectoriesOutput> {
  const consentFilter = input.consent ?? 'exportable';
  const rawEnv = input.rawEnv ?? process.env;

  if (consentFilter === 'all') {
    const confirm = rawEnv.MEMPHIS_EXPORT_CONFIRM?.trim();
    if (confirm !== '1' && confirm !== 'true') {
      throw new Error(
        'exportTrajectories: --consent all requires MEMPHIS_EXPORT_CONFIRM=1 (prevents accidental leak of local-only events)',
      );
    }
  }

  const chains = (input.chains && input.chains.length > 0 ? input.chains : EXPORTABLE_CHAINS).slice();
  const limitPerChain = input.limitPerChain ?? DEFAULT_LIMIT;
  const query = input.query ?? runMemphisChainQuery;

  const since = input.sinceIso ? Date.parse(input.sinceIso) : null;
  if (input.sinceIso && (since === null || Number.isNaN(since))) {
    throw new Error(`exportTrajectories: invalid --since value '${input.sinceIso}' (expected ISO-8601)`);
  }

  const events: TrajectoryEventT[] = [];
  const skipped: ExportTrajectoriesOutput['skipped'] = [];
  const chainHashes: Record<string, string> = {};
  let totalBlocks = 0;
  let filteredByConsent = 0;
  let anonymizedEvents = 0;

  for (const chain of chains) {
    const out = await query({ chain, limit: limitPerChain });
    // Capture the live chain tip (last block's hash) BEFORE any
    // consent/timestamp filtering. The integrity snapshot is a claim
    // about the on-disk chain at export time — if the newest blocks are
    // `local-only` under the default exporter filter, filtering-aware
    // capture would silently leave `chainHashes[chain]` off the live
    // tip (or omit the chain entirely). That breaks downstream consumers
    // verifying exported trajectories against the live chain.
    const tail = out.blocks[out.blocks.length - 1];
    if (tail && typeof tail.hash === 'string' && tail.hash.length > 0) {
      chainHashes[chain] = tail.hash;
    }
    for (const block of out.blocks) {
      totalBlocks += 1;
      if (since !== null) {
        const ts = typeof block.timestamp === 'string' ? Date.parse(block.timestamp) : NaN;
        if (!Number.isNaN(ts) && ts < since) continue;
      }
      // Prefer block-level data.source for surface attribution —
      // chain-only heuristic mislabels CLI reflect / telegram etc. writes
      // that share the journal chain with agent traces.
      const blockData = (block.data ?? {}) as Record<string, unknown>;
      const surface = resolveBlockSurface(blockData, chain);
      const mapped = mapBlockToEvent(block, chain, surface);
      if (!mapped.event) {
        skipped.push({
          chain,
          blockIndex: typeof block.index === 'number' ? block.index : -1,
          reason: mapped.reason ?? 'unknown',
        });
        continue;
      }
      const ev = mapped.event;
      if (!passesConsentFilter(ev.consent, consentFilter)) {
        filteredByConsent += 1;
        continue;
      }
      if (ev.consent === 'anonymized') anonymizedEvents += 1;
      events.push(ev);
    }
  }

  // Group into trajectories. Priority: block `data.conversation_id` →
  // `data.session_id` → per-turn bucket. See `sessionFromEvent`.
  const bySession = new Map<string, TrajectoryEventT[]>();
  for (const ev of events) {
    const sessionKey = sessionFromEvent(ev);
    const bucket = sessionKey || '__unbound__';
    const arr = bySession.get(bucket) ?? [];
    arr.push(ev);
    bySession.set(bucket, arr);
  }

  const agentIdentity = resolveAgentIdentity(rawEnv);
  const trajectories: TrajectoryT[] = [];
  for (const [sessionKey, sessEvents] of bySession.entries()) {
    const sorted = [...sessEvents].sort((a, b) => a.ts.localeCompare(b.ts));
    const startedAt = sorted[0]?.ts ?? new Date().toISOString();
    const completedAt = sorted[sorted.length - 1]?.ts ?? null;
    const turns = new Set(sorted.map((e) => e.turnId).filter((t): t is string => !!t)).size;

    const integrity: TrajectoryIntegrityT = {
      chainHashes,
      eventCount: sorted.length,
      signedEventCount: sorted.filter((e) => e.provenance?.signature).length,
    };

    trajectories.push({
      schemaVersion: SCHEMA_VERSION,
      trajectoryId: stableUuidFromSessionKey(sessionKey),
      sessionId: sessionKey === '__unbound__' ? null : sessionKey,
      agentIdentity,
      startedAt,
      completedAt,
      turns,
      events: sorted,
      integrity,
    });
  }

  // Validate each via the schema before returning — defense-in-depth
  // so a schema drift in this file is caught at export time, not by
  // downstream consumers. Parse failures are logged to `skipped` per the
  // exporter's graceful-degradation contract; one bad block must never
  // abort the whole export.
  const validTrajectories: TrajectoryT[] = [];
  for (const traj of trajectories) {
    try {
      Trajectory.parse(traj);
      validTrajectories.push(traj);
    } catch (err) {
      skipped.push({
        chain: 'trajectory',
        blockIndex: -1,
        reason: `schema-validation-failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  // Summary counters must reflect what actually ships — base on
  // `validTrajectories` not `trajectories`, otherwise CLI/manifest
  // outputs overstate event + session counts when schema validation
  // drops any trajectory.
  const includedEventsCount = validTrajectories.reduce(
    (sum, traj) => sum + traj.events.length,
    0,
  );
  return {
    trajectories: validTrajectories,
    skipped,
    summary: {
      totalEvents: totalBlocks,
      includedEvents: includedEventsCount,
      filteredByConsent,
      anonymizedEvents,
      sessionCount: validTrajectories.length,
      chainCount: chains.length,
    },
  };
}

function passesConsentFilter(
  eventConsent: ConsentLevelT,
  filter: ConsentLevelT | 'all',
): boolean {
  if (filter === 'all') return true;
  if (filter === 'exportable') return eventConsent === 'exportable' || eventConsent === 'anonymized';
  if (filter === 'anonymized') return eventConsent === 'anonymized' || eventConsent === 'exportable';
  // filter === 'local-only': pass only local-only events (for operator
  // inspection / migration flows; still requires explicit choice).
  return eventConsent === 'local-only';
}

function sessionFromEvent(ev: TrajectoryEventT): string {
  // Grouping priority:
  //   1. `data.conversation_id` / `data.session_id` stamped by the caller
  //      — not yet persisted by durable-memory writers (extension of N8),
  //      but honor it now so future blocks group correctly without another
  //      exporter change.
  //   2. Fallback: turnId itself. Runtime generates a new UUID per turn
  //      (see `generateTurnId` in src/gateway/turn-runtime.ts) — blocks
  //      from different turns of the same conversation share no common
  //      prefix, so each turn becomes its own 1-event trajectory. This
  //      is the documented v1 behavior; multi-turn grouping awaits
  //      conversation-id plumbing into block payloads.
  const payload = ev.payload as Record<string, unknown> | undefined;
  const metadata = (payload?.metadata as Record<string, unknown> | undefined) ?? undefined;
  for (const src of [payload, metadata]) {
    if (!src) continue;
    const cid = src.conversation_id ?? src.conversationId;
    if (typeof cid === 'string' && cid.length > 0) return `conversation:${cid}`;
    const sid = src.session_id ?? src.sessionId;
    if (typeof sid === 'string' && sid.length > 0) return `session:${sid}`;
  }
  return ev.turnId ? `turn:${ev.turnId}` : '';
}

/**
 * Deterministic UUID-v4-shaped identifier derived from the session key.
 * Stable across re-exports so consumers can idempotently ingest.
 */
function stableUuidFromSessionKey(key: string): string {
  const h = sha256Hex(`trajectory:${key}`).slice(0, 32);
  // Format as UUID-v4 (8-4-4-4-12). Set version + variant bits.
  const b = Buffer.from(h, 'hex');
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function resolveAgentIdentity(
  rawEnv: NodeJS.ProcessEnv,
): { agentName: string; ownerName: string; instanceId: string } {
  return {
    agentName: rawEnv.MEMPHIS_AGENT_NAME?.trim() || 'memphis',
    ownerName: rawEnv.MEMPHIS_OWNER_NAME?.trim() || 'operator',
    instanceId:
      rawEnv.MEMPHIS_INSTANCE_ID?.trim() || 'unknown-instance',
  };
}
