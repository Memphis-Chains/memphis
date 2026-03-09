import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ObservabilitySnapshot = {
  ts: string;
  requests: number;
  fallbackAttempts: number;
  totalAttempts: number;
  avgTimingMs: number;
  recentTimingsMs: number[];
  lastProvider?: string;
  lastError?: string;
  lastHealthSummary?: string;
};

type ObservabilityDisk = {
  version: 1;
  entries: ObservabilitySnapshot[];
};

const MAX_ENTRIES = 100;

export function observabilityPathFromEnv(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return resolve(rawEnv.TUI_OBSERVABILITY_PATH ?? 'data/tui-observability.json');
}

export function loadLatestSnapshot(path: string): ObservabilitySnapshot | null {
  const entries = loadSnapshots(path);
  if (entries.length === 0) return null;
  return entries[entries.length - 1] ?? null;
}

export function appendSnapshot(path: string, snapshot: ObservabilitySnapshot): void {
  const entries = loadSnapshots(path);
  const next = [...entries, snapshot].slice(-MAX_ENTRIES);
  const out: ObservabilityDisk = { version: 1, entries: next };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2));
}

export function loadSnapshots(path: string): ObservabilitySnapshot[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ObservabilityDisk>;
    if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed.entries;
  } catch {
    return [];
  }
  return [];
}

export function resetSnapshots(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, entries: [] } satisfies ObservabilityDisk, null, 2));
}
