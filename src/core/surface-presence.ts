/**
 * Cross-surface presence registry.
 *
 * In-memory map of { surface → recent activity } shared by every surface
 * (Telegram, TUI host, HTTP). Each inbound event calls recordSurfaceActivity;
 * /status on any surface can call getActiveSurfacesSnapshot to render a unified
 * view of who is active where.
 *
 * Entries older than staleMs (default 5 minutes) are marked stale in the
 * snapshot but not evicted — a restart would zero the map anyway, and we want
 * operators to see "Telegram idle 12m" rather than "Telegram — no history."
 */

export const DEFAULT_STALE_MS = 5 * 60 * 1000;

/** Known surface identifiers. Extensible — any string is accepted. */
export type SurfaceId = 'tui' | 'telegram' | 'http' | (string & {});

export type SurfaceTier = 0 | 1 | 2 | 3;

export interface RecordSurfaceActivityInput {
  surface: SurfaceId;
  actorId: string;
  tier?: SurfaceTier;
  tuiHostSessionId?: string;
  telegramChatId?: number | string;
  now?: number;
}

export interface SurfaceActivitySnapshot {
  surface: SurfaceId;
  lastActivityMs: number;
  ageMs: number;
  stale: boolean;
  tier: SurfaceTier | null;
  actorIds: string[];
  tuiHostSessionIds: string[];
  telegramChatIds: string[];
  activityCount: number;
}

export interface GetActiveSurfacesOptions {
  staleMs?: number;
  now?: number;
}

interface SurfaceActivityEntry {
  surface: SurfaceId;
  lastActivityMs: number;
  tier: SurfaceTier | null;
  actorIds: Set<string>;
  tuiHostSessionIds: Set<string>;
  telegramChatIds: Set<string>;
  activityCount: number;
}

const registry = new Map<SurfaceId, SurfaceActivityEntry>();

export function recordSurfaceActivity(input: RecordSurfaceActivityInput): void {
  const now = input.now ?? Date.now();
  const existing = registry.get(input.surface);
  const entry: SurfaceActivityEntry = existing ?? {
    surface: input.surface,
    lastActivityMs: now,
    tier: input.tier ?? null,
    actorIds: new Set<string>(),
    tuiHostSessionIds: new Set<string>(),
    telegramChatIds: new Set<string>(),
    activityCount: 0,
  };

  entry.lastActivityMs = now;
  if (input.tier !== undefined) entry.tier = input.tier;
  if (input.actorId) entry.actorIds.add(input.actorId);
  if (input.tuiHostSessionId) entry.tuiHostSessionIds.add(input.tuiHostSessionId);
  if (input.telegramChatId !== undefined) {
    entry.telegramChatIds.add(String(input.telegramChatId));
  }
  entry.activityCount += 1;

  registry.set(input.surface, entry);
}

export function getActiveSurfacesSnapshot(
  options: GetActiveSurfacesOptions = {},
): SurfaceActivitySnapshot[] {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now();

  const snapshots: SurfaceActivitySnapshot[] = [];
  for (const entry of registry.values()) {
    const ageMs = Math.max(0, now - entry.lastActivityMs);
    snapshots.push({
      surface: entry.surface,
      lastActivityMs: entry.lastActivityMs,
      ageMs,
      stale: ageMs > staleMs,
      tier: entry.tier,
      actorIds: Array.from(entry.actorIds),
      tuiHostSessionIds: Array.from(entry.tuiHostSessionIds),
      telegramChatIds: Array.from(entry.telegramChatIds),
      activityCount: entry.activityCount,
    });
  }

  return snapshots.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/** For tests and deterministic fixtures. Never call from production paths. */
export function resetSurfacePresence(): void {
  registry.clear();
}

// ── Formatter ────────────────────────────────────────────────────────────────

/**
 * Render a human-readable "Active surfaces:" block. Same output shape across
 * TUI, Telegram, and HTTP so operators see identical wording everywhere.
 */
export function formatSurfaceStatusLines(
  snapshots: SurfaceActivitySnapshot[],
): string[] {
  if (snapshots.length === 0) {
    return ['Active surfaces: (none)'];
  }
  const lines = ['Active surfaces:'];
  for (const s of snapshots) {
    const ageLabel = s.stale ? 'idle' : `last turn ${formatAgeShort(s.ageMs)} ago`;
    const tierLabel = s.tier !== null ? `tier ${s.tier}` : 'tier ?';
    const actor = formatActorLabel(s);
    const parts = [`  ${s.surface.padEnd(8)}`, ageLabel.padEnd(22), tierLabel.padEnd(8), actor];
    lines.push(parts.filter((p) => p.trim().length > 0).join(' '));
  }
  return lines;
}

function formatActorLabel(s: SurfaceActivitySnapshot): string {
  if (s.surface === 'telegram' && s.telegramChatIds.length > 0) {
    const primary = s.telegramChatIds[0];
    const more = s.telegramChatIds.length - 1;
    return more > 0 ? `(chat ${primary} +${more})` : `(chat ${primary})`;
  }
  if (s.actorIds.length === 0) return '';
  const primary = s.actorIds[0];
  const more = s.actorIds.length - 1;
  return more > 0 ? `(${primary} +${more})` : `(${primary})`;
}

function formatAgeShort(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h${remMin}m`;
}
