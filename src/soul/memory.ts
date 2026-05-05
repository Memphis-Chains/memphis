import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  MEMORY_SCHEMA_VERSION,
  soulMemorySchema,
  type MemoryActionEntry,
  type MemoryActionType,
  type SoulMemory,
  type SoulMemoryUpdate,
} from './types.js';
import { MEMPHIS_AGENT_NAME } from '../config/env-registry.js';
import { getConfigPath } from '../config/paths.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';
import { healSensitiveFilePerms, writeSensitiveFile } from '../infra/storage/secure-file.js';
import { storeVaultSecret } from '../security/vault-boundary.js';

export function getSoulMemoryPath(_rawEnv: NodeJS.ProcessEnv = process.env): string {
  return getConfigPath('soul-memory.json');
}

export function emptySoulMemory(): SoulMemory {
  // Optional string fields are written as `undefined` rather than
  // omitted so `Object.keys()` yields them — `isSoulMemoryEmpty` walks
  // the empty-baseline keys and would otherwise miss `name`,
  // `personality`, `activeWork`. Adding a new optional field anywhere
  // in SoulMemoryUser/Self/Context REQUIRES adding it here too,
  // because the explicit `SoulMemory` return type makes any
  // omission a typecheck error if the field is required, and the
  // structural exhaustiveness test in `tests/unit/soul-memory.test.ts`
  // catches optional-field omissions.
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    user: {
      name: undefined,
      languages: [],
      preferences: [],
      expertise: [],
      integrations: [],
    },
    self: {
      personality: undefined,
      strengths: [],
      learnings: [],
      evolvedCapabilities: [],
    },
    context: {
      activeWork: undefined,
      recentDecisions: [],
    },
  };
}

export function loadSoulMemory(rawEnv: NodeJS.ProcessEnv = process.env): SoulMemory | null {
  const memoryPath = getSoulMemoryPath(rawEnv);
  if (!existsSync(memoryPath)) return null;

  // Heal-on-load: tighten 0600 if the file was created before
  // writeSensitiveFile-based writers landed (existing operator installs
  // had 664 on disk).
  healSensitiveFilePerms(memoryPath);

  try {
    const raw = JSON.parse(readFileSync(memoryPath, 'utf8')) as unknown;
    return soulMemorySchema.parse(raw);
  } catch {
    return null;
  }
}

export function writeSoulMemory(memory: SoulMemory, rawEnv: NodeJS.ProcessEnv = process.env): void {
  const memoryPath = getSoulMemoryPath(rawEnv);
  // 0600 mode + parent dir 0700 + atomic rename — see secure-file.ts.
  // soul-memory carries operator's identity narrative + memory entries;
  // group/world readability is a privacy leak, not just a hardening
  // gap.
  writeSensitiveFile(memoryPath, JSON.stringify(memory, null, 2));
}

/**
 * "Empty" means the operator hasn't accumulated any user-meaningful
 * content yet — schema-version + lastUpdated metadata is excluded.
 *
 * Implementation note (issue #398 — exhaustive-by-construction):
 * the function iterates over the keys of `emptySoulMemory()` for
 * each content section instead of listing every field by hand.
 * Consequence: when a future change adds a field to
 * `SoulMemoryUser` / `SoulMemorySelf` / `SoulMemoryContext`, the
 * field must also exist in `emptySoulMemory()` (compile-time
 * enforced via the explicit `SoulMemory` return type), and this
 * comparison automatically picks it up — no separate "remember to
 * update isSoulMemoryEmpty" step. The previous hand-written `&&`
 * chain was a documented foot-gun (the `ta10-soul-memory` doctor
 * warn flagged it heuristically).
 */
const SOUL_MEMORY_CONTENT_SECTIONS = ['user', 'self', 'context'] as const;

function isContentValueEmpty(value: unknown, baseline: unknown): boolean {
  // Optional string field (`name?`, `personality?`, `activeWork?`):
  // baseline is `undefined`. Counts as empty when nullish or empty
  // string.
  if (typeof baseline === 'undefined') {
    return value === undefined || value === null || value === '';
  }
  // Required array field (`languages`, `preferences`, …): baseline
  // is `[]`. Counts as empty only when the value is an array of
  // length 0. A non-array (corruption / shape drift) is treated as
  // "not empty" so we don't silently downgrade tampered memory.
  if (Array.isArray(baseline)) {
    return Array.isArray(value) && value.length === 0;
  }
  // Required scalar field (none today, but covers future drift):
  // baseline is the canonical empty value; fall through to strict
  // equality.
  return value === baseline;
}

export function isSoulMemoryEmpty(memory: SoulMemory): boolean {
  if (!memory) return true;
  const empty = emptySoulMemory();
  for (const section of SOUL_MEMORY_CONTENT_SECTIONS) {
    const baseline = empty[section] as unknown as Record<string, unknown>;
    const actual = memory[section] as unknown as Record<string, unknown> | undefined;
    if (!actual) continue; // missing section equates to empty section
    for (const key of Object.keys(baseline)) {
      if (!isContentValueEmpty(actual[key], baseline[key])) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Deep-merge an update into existing soul memory.
 * String arrays are appended with deduplication. Scalar fields are overwritten.
 */
export function updateSoulMemory(
  update: SoulMemoryUpdate,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SoulMemory {
  const current = loadSoulMemory(rawEnv) ?? emptySoulMemory();

  if (update.user) {
    if (update.user.name !== undefined) current.user.name = update.user.name;
    if (update.user.languages) {
      current.user.languages = dedupeAppend(current.user.languages, update.user.languages);
    }
    if (update.user.preferences) {
      current.user.preferences = dedupeAppend(current.user.preferences, update.user.preferences);
    }
    if (update.user.expertise) {
      current.user.expertise = dedupeAppend(current.user.expertise, update.user.expertise);
    }
    if (update.user.integrations) {
      current.user.integrations = dedupeAppend(current.user.integrations, update.user.integrations);
    }
  }

  if (update.self) {
    if (update.self.personality !== undefined) current.self.personality = update.self.personality;
    if (update.self.strengths) {
      current.self.strengths = dedupeAppend(current.self.strengths, update.self.strengths);
    }
    if (update.self.learnings) {
      current.self.learnings = dedupeAppend(current.self.learnings, update.self.learnings);
    }
    if (update.self.evolvedCapabilities) {
      current.self.evolvedCapabilities = dedupeAppend(
        current.self.evolvedCapabilities,
        update.self.evolvedCapabilities,
      );
    }
  }

  if (update.context) {
    if (update.context.activeWork !== undefined) {
      current.context.activeWork = update.context.activeWork;
    }
    if (update.context.recentDecisions) {
      current.context.recentDecisions = dedupeAppend(
        current.context.recentDecisions,
        update.context.recentDecisions,
      );
    }
  }

  current.lastUpdated = new Date().toISOString();
  writeSoulMemory(current, rawEnv);
  return current;
}

function dedupeAppend(existing: string[], additions: string[]): string[] {
  const set = new Set(existing);
  for (const item of additions) {
    set.add(item);
  }
  return [...set];
}

// ── MEMORY.md (Burn-After-Action) ─────────────────────────────────────────────

const MEMORY_ROTATION_THRESHOLD = parseInt(process.env.MEMORY_ROTATION_THRESHOLD ?? '50', 10);

export function getMemoryPath(_rawEnv: NodeJS.ProcessEnv = process.env): string {
  return getConfigPath('memory.md');
}

export function loadMemoryEntries(rawEnv: NodeJS.ProcessEnv = process.env): MemoryActionEntry[] {
  const memoryPath = getMemoryPath(rawEnv);
  if (!existsSync(memoryPath)) return [];

  try {
    const raw = readFileSync(memoryPath, 'utf8');
    const entries: MemoryActionEntry[] = [];
    const lines = raw.split('\n');

    for (const line of lines) {
      const match = line.match(
        /^-\[(\S+)\]\s(\S+)\s(\S+)\s(\S+)(?:\s burned:(\S+))?(?:\s burnedAt:(\S+))?\s\|\s(.+)/,
      );
      if (match) {
        entries.push({
          id: match[1]!,
          timestamp: match[2]!,
          actionType: match[3] as MemoryActionType,
          summary: match[7]!,
          burned: match[5] === 'true',
          burnedAt: match[6],
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function writeMemoryAction(
  actionType: MemoryActionType,
  summary: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemoryActionEntry {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: MemoryActionEntry = {
    id,
    timestamp: new Date().toISOString(),
    actionType,
    summary,
    burned: false,
  };

  const memoryPath = getMemoryPath(rawEnv);
  const dir = path.dirname(memoryPath);
  mkdirSync(dir, { recursive: true });

  const line = formatMemoryLine(entry);
  const content = `${line}\n`;
  appendFileSync(memoryPath, content, 'utf8');

  // Write to journal chain
  void appendBlock('soul', {
    type: 'memory.action',
    source: 'soul',
    schemaVersion: 1,
    payload: { id, actionType, summary },
  }).catch(() => {
    // journal write is best-effort
  });

  // Check threshold and rotate if needed
  const entries = loadMemoryEntries(rawEnv);
  if (entries.length >= MEMORY_ROTATION_THRESHOLD) {
    rotateMemoryFile(rawEnv);
  }

  return entry;
}

export function burnMemoryAction(id: string, rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const memoryPath = getMemoryPath(rawEnv);
  if (!existsSync(memoryPath)) return false;

  const entries = loadMemoryEntries(rawEnv);
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.burned) return false;

  // Mark as burned
  entry.burned = true;
  entry.burnedAt = new Date().toISOString();

  // Rewrite file with updated entry
  const agentName = MEMPHIS_AGENT_NAME.read(process.env);
  const header = [
    `# MEMORY — ${agentName}`,
    `Burn-After-Action Log | Threshold: ${MEMORY_ROTATION_THRESHOLD}`,
    '',
    '## Actions',
  ].join('\n');

  const lines = entries.map(formatMemoryLine);
  const content = `${header}\n${lines.join('\n')}\n`;

  const tmpPath = `${memoryPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, memoryPath);

  // Write burn event to journal chain
  void appendBlock('soul', {
    type: 'memory.burn',
    source: 'soul',
    schemaVersion: 1,
    payload: { id, burnedAt: entry.burnedAt },
  }).catch(() => {
    // journal write is best-effort
  });

  return true;
}

export function rotateMemoryFile(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const memoryPath = getMemoryPath(rawEnv);
  if (!existsSync(memoryPath)) return;

  // Read current entries
  const entries = loadMemoryEntries(rawEnv);
  if (entries.length === 0) return;

  // Mark all as burned for the archive
  const burnedAt = new Date().toISOString();
  const archivedEntries = entries.map((e) => ({ ...e, burned: true, burnedAt }));

  const agentName = MEMPHIS_AGENT_NAME.read(process.env);

  const header = [
    `# MEMORY ARCHIVE — ${agentName}`,
    `Archived: ${burnedAt}`,
    `Original entries: ${entries.length}`,
    '',
    '## Actions',
  ].join('\n');

  const lines = archivedEntries.map(formatMemoryLine);
  const content = `${header}\n${lines.join('\n')}\n`;

  const archiveKey = `memory_archive_${burnedAt.replace(/[:.]/g, '-')}`;
  try {
    storeVaultSecret(archiveKey, content, { surface: 'system', command: 'memory-rotate' }, rawEnv);
  } catch {
    const archivePath = getConfigPath(`memory-archive-${Date.now()}.md`);
    writeFileSync(archivePath, content, 'utf8');
    console.warn('Vault unavailable for memory archive — falling back to plaintext.');
  }

  // Clear the active memory.md
  const memoryHeader = [
    `# MEMORY — ${agentName}`,
    `Burn-After-Action Log | Threshold: ${MEMORY_ROTATION_THRESHOLD}`,
    '',
    '## Actions',
  ].join('\n');
  writeFileSync(memoryPath, `${memoryHeader}\n`, 'utf8');
}

function formatMemoryLine(entry: MemoryActionEntry): string {
  const parts = [
    `-[${entry.id}]`,
    entry.timestamp,
    entry.actionType,
    entry.burned ? 'burned:true' : 'active',
    entry.burnedAt ? `burnedAt:${entry.burnedAt}` : '',
    `| ${entry.summary}`,
  ]
    .filter(Boolean)
    .join(' ');
  return parts;
}

// appendFileSync is imported from node:fs — handles both new and existing files correctly.
