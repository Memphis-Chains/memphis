import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  MEMORY_SCHEMA_VERSION,
  soulMemorySchema,
  type SoulMemory,
  type SoulMemoryUpdate,
} from './types.js';
import { getConfigPath } from '../config/paths.js';

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
  writeFileSync(tmpPath, JSON.stringify(memory, null, 2), 'utf8');
  renameSync(tmpPath, memoryPath);
}

export function isSoulMemoryEmpty(memory: SoulMemory): boolean {
  return (
    !memory.user.name &&
    memory.user.preferences.length === 0 &&
    memory.user.languages.length === 0 &&
    memory.user.expertise.length === 0 &&
    memory.user.integrations.length === 0 &&
    memory.self.learnings.length === 0 &&
    memory.self.strengths.length === 0 &&
    memory.self.evolvedCapabilities.length === 0 &&
    !memory.self.personality &&
    !memory.context.activeWork &&
    memory.context.recentDecisions.length === 0
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
