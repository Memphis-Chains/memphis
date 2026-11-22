import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { scanContent } from '../../security/content-scan.js';

export type EvolveRequestPayload = { intent: string; files: string[]; changes: Record<string, string>;
  plan_id?: string; step_idx?: number };
export type EvolveRequest = { id: string; root: string; payload: string; digest: string;
  status: 'pending' | 'preparing' | 'prepared' | 'failed'; createdAt: string; expiresAtMs: number; sessionId: string | null };

/**
 * The refusal when a model sends a passphrase to the tool.
 *
 * The agent never sees the operator's secret: the passphrase is typed by
 * the operator in a local terminal (`memphis evolve prepare <id>`). Both
 * arms say the same words, so the model gets the same correction wherever
 * it asked — and the wording lives here, once, instead of in three places.
 */
export const PASSPHRASE_REFUSAL =
  'do not send a passphrase to the agent; use the local evolve prepare command';

/**
 * The transport key: how the gateway asks for approval, not an argument
 * the tool takes.
 *
 * The registry declares it, the model-facing schema drops it, and the MCP
 * approval gate hands it to the handler — so the rule has to tolerate it
 * instead of calling it an unknown field.
 */
const TRANSPORT_KEYS = new Set(['approval_request_id']);

/** The arguments the registry declares for this tool, in the registry's order. */
const REQUEST_FIELDS = ['intent', 'files', 'changes', 'plan_id', 'step_idx'];

export type CanonicalEvolveRequest = {
  /** The request in the registry's shape, with the changes keyed by file. */
  request: EvolveRequestPayload;
  /** The exact bytes that are stored and digested. */
  payload: string;
};
export const EVOLVE_REQUEST_SCHEMA = `CREATE TABLE IF NOT EXISTS evolve_requests (
  id TEXT PRIMARY KEY, root TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','preparing','prepared','failed')),
  created_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, session_id TEXT
)`;
export function evolveRequestDigest(payload: string): string { return createHash('sha256').update(payload, 'utf8').digest('hex'); }

export function validateEvolveRequest(input: EvolveRequestPayload): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['intent', 'files', 'changes', 'plan_id', 'step_idx'].includes(key)))
    throw new Error('invalid evolution request fields');
  if (typeof input.intent !== 'string' || !input.intent.trim() || input.intent.length > 512 ||
      !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 50 ||
      !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw new Error('invalid evolution request');
  if (new Set(input.files).size !== input.files.length || Object.keys(input.changes).length !== input.files.length ||
      Object.keys(input.changes).some((file) => !input.files.includes(file))) throw new Error('request files and changes must match');
  for (const file of input.files) {
    if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') ||
        file.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'dist' || part === 'node_modules' || part === 'vault') ||
        file.endsWith('vault-state.json') || file.endsWith('vault-entries.json') || file.endsWith('.tier2-passphrase'))
      throw new Error('request contains a forbidden file path');
    const content = input.changes[file];
    if (typeof content !== 'string' || !scanContent(content, 'code-change').allowed) throw new Error('request contains blocked content');
  }
  if ((input.plan_id === undefined) !== (input.step_idx === undefined) ||
      (input.plan_id !== undefined && (typeof input.plan_id !== 'string' || !input.plan_id || input.plan_id.length > 200 ||
        !Number.isSafeInteger(input.step_idx) || input.step_idx! < 0))) throw new Error('invalid plan reference');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 1_048_576) throw new Error('evolution request exceeds one MiB');
}

/**
 * Turn raw tool arguments into THE request — one shape, one set of rules,
 * one canonical payload.
 *
 * ## Why this function exists
 *
 * `memphis_self_modify` had three implementations that did not agree:
 *
 *   - the MCP server (src/mcp/server.ts) read `intent`, `files`,
 *     `changes`, `plan_id`, `step_idx` and handed them to the store;
 *   - the gateway's own executor
 *     (src/gateway/tool-executor/domains/self-modify-tools.ts) read the
 *     same five fields but NORMALISED them first — it filtered junk out of
 *     `files` instead of refusing it, and it had a passphrase refusal the
 *     MCP arm did not;
 *   - the native arm (crates/memphis-operator/src/chat_self_modify.rs)
 *     accepted `{path, content, mode}` and wrote ONE file — a second
 *     operation under one name.
 *
 * Three copies of the same rule is three rules that drift. So the rule
 * lives here, once, and the native arm has its mirror; the case table in
 * `tests/fixtures/self-modify-contract.json` checks both.
 *
 * ## The canonical payload
 *
 * The payload is the bytes that get stored, digested and shown to the
 * operator, so it has to be the SAME bytes on every arm: the fields in the
 * registry's order, the changes keyed in the order of `files`, the optional
 * plan reference present only when it was given. A model that sends the
 * same request twice gets the same digest on Telegram and in the cockpit.
 */
export function canonicalEvolveRequest(raw: unknown): CanonicalEvolveRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid evolution request fields');
  }
  const args = raw as Record<string, unknown>;

  // A passphrase is the one stray key that gets its own words: the model
  // is asking for something the agent must never hold.
  if ('passphrase' in args) throw new Error(PASSPHRASE_REFUSAL);
  for (const key of Object.keys(args)) {
    if (REQUEST_FIELDS.includes(key) || TRANSPORT_KEYS.has(key)) continue;
    throw new Error('invalid evolution request fields');
  }

  // The registry's five fields, passed through untouched. The rule below
  // decides what is acceptable; a second opinion here would be a second
  // rule, and the two would disagree about the same call.
  const picked: Record<string, unknown> = {
    intent: args.intent,
    files: args.files,
    changes: args.changes,
  };
  if ('plan_id' in args) picked.plan_id = args.plan_id;
  if ('step_idx' in args) picked.step_idx = args.step_idx;

  validateEvolveRequest(picked as unknown as EvolveRequestPayload);

  const files = picked.files as string[];
  const changes = picked.changes as Record<string, string>;
  const ordered: Record<string, unknown> = {
    intent: picked.intent,
    files,
    changes: Object.fromEntries(files.map((file) => [file, changes[file]])),
  };
  if (picked.plan_id !== undefined) ordered.plan_id = picked.plan_id;
  if (picked.step_idx !== undefined) ordered.step_idx = picked.step_idx;

  return {
    request: ordered as unknown as EvolveRequestPayload,
    payload: JSON.stringify(ordered),
  };
}

export class EvolveRequestStore {
  constructor(private readonly db: Database.Database) { db.exec(EVOLVE_REQUEST_SCHEMA); }
  create(root: string, input: EvolveRequestPayload): EvolveRequest {
    const { payload } = canonicalEvolveRequest(input);
    const id = randomBytes(16).toString('hex');
    const record: EvolveRequest = { id, root: realpathSync(resolve(root)), payload, digest: evolveRequestDigest(payload),
      status: 'pending', createdAt: new Date().toISOString(), expiresAtMs: Date.now() + 24 * 60 * 60 * 1000, sessionId: null };
    this.db.prepare('INSERT INTO evolve_requests VALUES (?,?,?,?,?,?,?,?)').run(record.id, record.root, record.payload,
      record.digest, record.status, record.createdAt, record.expiresAtMs, null);
    return record;
  }
  get(id: string): EvolveRequest | null {
    const r = this.db.prepare('SELECT * FROM evolve_requests WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? { id: String(r.id), root: String(r.root), payload: String(r.payload), digest: String(r.digest),
      status: r.status as EvolveRequest['status'], createdAt: String(r.created_at), expiresAtMs: Number(r.expires_at_ms),
      sessionId: r.session_id === null ? null : String(r.session_id) } : null;
  }
  list(): Array<Omit<EvolveRequest, 'payload'>> {
    const rows = this.db.prepare('SELECT id FROM evolve_requests ORDER BY created_at DESC LIMIT 100').all() as Array<{ id: string }>;
    return rows.map(({ id }) => {
      const row = this.get(id)!;
      return { id: row.id, root: row.root, digest: row.digest, status: row.status,
        createdAt: row.createdAt, expiresAtMs: row.expiresAtMs, sessionId: row.sessionId };
    });
  }
  claim(id: string, digest: string, payload: string, root: string): void {
    const result = this.db.prepare("UPDATE evolve_requests SET status='preparing' WHERE id=? AND digest=? AND payload=? AND root=? AND status='pending' AND expires_at_ms>?")
      .run(id, digest, payload, root, Date.now());
    if (result.changes !== 1) throw new Error('request changed, expired, or was already claimed');
  }
  finish(id: string, digest: string, success: boolean, sessionId?: string): void {
    const result = this.db.prepare("UPDATE evolve_requests SET status=?, session_id=? WHERE id=? AND digest=? AND status='preparing'")
      .run(success ? 'prepared' : 'failed', sessionId || null, id, digest);
    if (result.changes !== 1) throw new Error('request outcome requires operator inspection');
  }
}
