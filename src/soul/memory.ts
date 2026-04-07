import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
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
import { getConfigPath } from '../config/paths.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';

export function getSoulMemoryPath(_rawEnv: NodeJS.ProcessEnv = process.env): string {
  return getConfigPath('soul-memory.json');
}

export function emptySoulMemory(): SoulMemory {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    user: {
      languages: [],
      preferences: [],
      expertise: [],
      integrations: [],
    },
    self: {
      strengths: [],
      learnings: [],
      evolvedCapabilities: [],
    },
    context: {
      recentDecisions: [],
    },
  };
}

export function loadSoulMemory(rawEnv: NodeJS.ProcessEnv = process.env): SoulMemory | null {
  const memoryPath = getSoulMemoryPath(rawEnv);
  if (!existsSync(memoryPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(memoryPath, 'utf8')) as unknown;
    return soulMemorySchema.parse(raw);
  } catch {
    return null;
  }
}

export function writeSoulMemory(memory: SoulMemory, rawEnv: NodeJS.ProcessEnv = process.env): void {
  const memoryPath = getSoulMemoryPath(rawEnv);
  const dir = path.dirname(memoryPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${memoryPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(memory, null, 2), 'utf8');
    renameSync(tmpPath, memoryPath);
  } catch (error) {
    unlinkSync(tmpPath);
    throw error;
  }
}

export function isSoulMemoryEmpty(memory: SoulMemory): boolean {
  return (
    !memory?.user?.name &&
    (memory?.user?.preferences?.length ?? 0) === 0 &&
    (memory?.user?.languages?.length ?? 0) === 0 &&
    (memory?.user?.expertise?.length ?? 0) === 0 &&
    (memory?.user?.integrations?.length ?? 0) === 0 &&
    (memory?.self?.learnings?.length ?? 0) === 0 &&
    (memory?.self?.strengths?.length ?? 0) === 0 &&
    (memory?.self?.evolvedCapabilities?.length ?? 0) === 0 &&
    !memory?.self?.personality &&
    !memory?.context?.activeWork &&
    (memory?.context?.recentDecisions?.length ?? 0) === 0
  );
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
  const agentName = process.env.MEMPHIS_AGENT_NAME ?? 'Memphis Agent';
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

  // TODO: vault-encrypt and archive to vault
  // For now, just archive to a backup file
  const archivePath = getConfigPath(`memory-archive-${Date.now()}.md`);
  const agentName = process.env.MEMPHIS_AGENT_NAME ?? 'Memphis Agent';

  const header = [
    `# MEMORY ARCHIVE — ${agentName}`,
    `Archived: ${burnedAt}`,
    `Original entries: ${entries.length}`,
    '',
    '## Actions',
  ].join('\n');

  const lines = archivedEntries.map(formatMemoryLine);
  const content = `${header}\n${lines.join('\n')}\n`;

  writeFileSync(archivePath, content, 'utf8');

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
