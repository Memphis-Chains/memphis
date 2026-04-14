import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

import { resolveAuditArchiveDir, resolveAuditLogPath } from './audit-rotation.js';

export interface AuditSearchCriteria {
  since?: string;
  until?: string;
  action?: string;
  status?: 'allowed' | 'blocked' | 'error';
  contains?: string;
  limit?: number;
}

export interface AuditRecord {
  ts: string;
  action: string;
  status: string;
  ip?: string;
  route?: string;
  details?: Record<string, unknown>;
  raw: string;
  source: string;
}

function listArchiveFilesNewestFirst(archiveDir: string): string[] {
  if (!existsSync(archiveDir)) return [];
  const entries = readdirSync(archiveDir);
  return entries
    .filter((name) => name.startsWith('security-audit-') && name.endsWith('.jsonl.gz'))
    .sort()
    .reverse()
    .map((name) => join(archiveDir, name));
}

async function* streamLinesFromFile(path: string, gzipped: boolean): AsyncIterable<string> {
  const stream = createReadStream(path);
  const rl = createInterface({
    input: gzipped ? stream.pipe(createGunzip()) : stream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

async function readAllLines(path: string, gzipped: boolean): Promise<string[]> {
  const out: string[] = [];
  for await (const line of streamLinesFromFile(path, gzipped)) out.push(line);
  return out;
}

function parseLine(line: string, source: string): AuditRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as {
      ts?: string;
      action?: string;
      status?: string;
      ip?: string;
      route?: string;
      details?: Record<string, unknown>;
    };
    if (!parsed.ts || !parsed.action || !parsed.status) return null;
    return {
      ts: parsed.ts,
      action: parsed.action,
      status: parsed.status,
      ip: parsed.ip,
      route: parsed.route,
      details: parsed.details,
      raw: line,
      source,
    };
  } catch {
    return null;
  }
}

function toInstant(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matches(record: AuditRecord, criteria: AuditSearchCriteria): boolean {
  // Compare timestamps as numeric instants, not as strings. Lexicographic
  // compare only works when both sides share the exact ISO shape; inputs
  // with different precision (`Z` vs `000Z`) or zone offsets (`+02:00`)
  // get ordered wrong, returning incorrect results around the boundary.
  if (criteria.since) {
    const sinceMs = toInstant(criteria.since);
    const recordMs = toInstant(record.ts);
    if (sinceMs !== null && recordMs !== null && recordMs < sinceMs) return false;
  }
  if (criteria.until) {
    const untilMs = toInstant(criteria.until);
    const recordMs = toInstant(record.ts);
    if (untilMs !== null && recordMs !== null && recordMs > untilMs) return false;
  }
  if (criteria.action && !record.action.startsWith(criteria.action)) return false;
  if (criteria.status && record.status !== criteria.status) return false;
  if (criteria.contains) {
    const needle = criteria.contains.toLowerCase();
    if (!record.raw.toLowerCase().includes(needle)) return false;
  }
  return true;
}

export interface AuditSearchResult {
  records: AuditRecord[];
  filesScanned: string[];
  truncated: boolean;
}

export async function searchAuditLog(
  criteria: AuditSearchCriteria,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AuditSearchResult> {
  const limit = criteria.limit ?? 100;
  const currentPath = resolveAuditLogPath(rawEnv);
  const archiveDir = resolveAuditArchiveDir(rawEnv);

  const records: AuditRecord[] = [];
  const filesScanned: string[] = [];
  let truncated = false;

  const sources: Array<{ path: string; gzipped: boolean; label: string }> = [];
  if (existsSync(currentPath)) {
    sources.push({ path: currentPath, gzipped: false, label: 'current' });
  }
  for (const archivePath of listArchiveFilesNewestFirst(archiveDir)) {
    sources.push({ path: archivePath, gzipped: true, label: archivePath });
  }

  for (const source of sources) {
    filesScanned.push(source.label);
    const lines = await readAllLines(source.path, source.gzipped);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const record = parseLine(lines[i], source.label);
      if (!record) continue;
      if (!matches(record, criteria)) continue;
      records.push(record);
      if (records.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { records, filesScanned, truncated };
}
