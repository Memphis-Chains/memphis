import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { scanContent } from '../../security/content-scan.js';

export type EvolveRequestPayload = { intent: string; files: string[]; changes: Record<string, string>;
  plan_id?: string; step_idx?: number };
export type EvolveRequest = { id: string; root: string; payload: string; digest: string;
  status: 'pending' | 'preparing' | 'prepared' | 'failed'; createdAt: string; expiresAtMs: number; sessionId: string | null };
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

export class EvolveRequestStore {
  constructor(private readonly db: Database.Database) { db.exec(EVOLVE_REQUEST_SCHEMA); }
  create(root: string, input: EvolveRequestPayload): EvolveRequest {
    validateEvolveRequest(input);
    const payload = JSON.stringify(input); const id = randomBytes(16).toString('hex');
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
