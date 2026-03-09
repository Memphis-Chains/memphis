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
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ObservabilityDisk>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length === 0) return null;
    return parsed.entries[parsed.entries.length - 1] ?? null;
  } catch {
    return null;
  }
}

export function appendSnapshot(path: string, snapshot: ObservabilitySnapshot): void {
  let entries: ObservabilitySnapshot[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ObservabilityDisk>;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) entries = parsed.entries;
    } catch {
      entries = [];
    }
  }

  const next = [...entries, snapshot].slice(-MAX_ENTRIES);
  const out: ObservabilityDisk = { version: 1, entries: next };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2));
}
