import { CaseChainAdapter } from '../../infra/storage/case-chain-adapter.js';
import { appendBlock, type AppendBlockResult } from '../../infra/storage/chain-adapter.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';
import { ensureSoulManifest, loadSoulManifest } from '../../soul/manifest.js';
import { loadSoulMemory, updateSoulMemory } from '../../soul/memory.js';
import type { SoulMemory, SoulMemoryUpdate } from '../../soul/types.js';

// ── Soul Read ────────────────────────────────────────────────────────────────

export type MemphisSoulReadInput = {
  section?: 'user' | 'self' | 'context' | 'all';
};

export type SoulReadResult = {
  manifest: { agent: string; owner: string; mode: string; created: string };
  memory: Partial<Pick<SoulMemory, 'user' | 'self' | 'context'>> | null;
};

export type SoulReadDeps = {
  loadMemory: typeof loadSoulMemory;
  loadManifest: typeof loadSoulManifest;
  ensureManifest: typeof ensureSoulManifest;
};

const defaultReadDeps: SoulReadDeps = {
  loadMemory: loadSoulMemory,
  loadManifest: loadSoulManifest,
  ensureManifest: ensureSoulManifest,
};

export async function runMemphisSoulRead(
  input: MemphisSoulReadInput,
  deps: SoulReadDeps = defaultReadDeps,
): Promise<SoulReadResult> {
  const manifest = deps.loadManifest() ?? deps.ensureManifest();
  const memory = deps.loadMemory();
  const section = input.section ?? 'all';

  const manifestSummary = {
    agent: manifest.identity.agentName,
    owner: manifest.identity.ownerName,
    mode: manifest.identity.runtimeMode,
    created: manifest.identity.createdAt,
  };

  if (!memory) {
    return { manifest: manifestSummary, memory: null };
  }

  if (section === 'all') {
    return {
      manifest: manifestSummary,
      memory: { user: memory.user, self: memory.self, context: memory.context },
    };
  }

  return {
    manifest: manifestSummary,
    memory: { [section]: memory[section] },
  };
}

// ── Soul Write ───────────────────────────────────────────────────────────────

export type MemphisSoulWriteInput = {
  updates: SoulMemoryUpdate;
};

export type SoulWriteResult = {
  success: boolean;
  updated: string[];
  timestamp: string;
  soulChain?: Pick<AppendBlockResult, 'index' | 'hash' | 'chain'>;
  auditWarning?: string;
  error?: string;
  patternId?: string;
};

export type SoulWriteDeps = {
  update: typeof updateSoulMemory;
  caseAdapter: CaseChainAdapter;
  appendSoulAudit: typeof appendBlock;
};

const defaultWriteDeps: SoulWriteDeps = {
  update: updateSoulMemory,
  caseAdapter: new CaseChainAdapter(),
  appendSoulAudit: appendBlock,
};

export async function runMemphisSoulWrite(
  input: MemphisSoulWriteInput,
  deps: SoulWriteDeps = defaultWriteDeps,
): Promise<SoulWriteResult> {
  const updatedSections: string[] = [];

  if (input.updates.user) updatedSections.push('user');
  if (input.updates.self) updatedSections.push('self');
  if (input.updates.context) updatedSections.push('context');

  if (updatedSections.length === 0) {
    return { success: true, updated: [], timestamp: new Date().toISOString() };
  }

  const scan = scanContent(JSON.stringify(input.updates), 'memory');
  if (!scan.allowed) {
    await emitRuntimeSecurityEvent({
      action: 'content_scan.soul_write.blocked',
      status: 'blocked',
      details: {
        patternId: scan.patternId,
        reason: scan.reason,
        profile: scan.profile,
        contentHash: scan.contentHash,
      },
    });
    return {
      success: false,
      updated: [],
      timestamp: new Date().toISOString(),
      error: `Blocked soul write: ${scan.reason}`,
      patternId: scan.patternId,
    };
  }

  const merged = deps.update(input.updates);
  let soulChain: SoulWriteResult['soulChain'];
  let auditWarning: string | undefined;

  try {
    const audit = await deps.appendSoulAudit('soul', {
      type: 'system_event',
      kind: 'soul.memory_update',
      source: 'memphis_soul_write',
      schemaVersion: 1,
      updatedSections,
      changedKeys: buildChangedKeys(input.updates),
    });
    soulChain = { index: audit.index, hash: audit.hash, chain: audit.chain };
  } catch (error) {
    auditWarning = `soul chain audit write failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Record soul changes to case chain for auditability
  for (const section of updatedSections) {
    const possessed = summarizePossessed(section, input.updates);
    const object = summarizeChange(section, input.updates);

    try {
      // Genitive: soul owns this knowledge
      await deps.caseAdapter.appendCaseEntry({
        case_type: 'genitive',
        owner: 'soul',
        possessed,
      });

      // Accusative: agent learned something
      await deps.caseAdapter.appendCaseEntry({
        case_type: 'accusative',
        subject: 'agent',
        verb: 'learned',
        object,
      });
    } catch {
      // Case chain recording is best-effort; don't fail the write
    }
  }

  return {
    success: true,
    updated: updatedSections,
    timestamp: merged.lastUpdated,
    ...(soulChain ? { soulChain } : {}),
    ...(auditWarning ? { auditWarning } : {}),
  };
}

function buildChangedKeys(updates: SoulMemoryUpdate): string[] {
  const keys: string[] = [];
  for (const [section, sectionData] of Object.entries(updates)) {
    if (!sectionData || typeof sectionData !== 'object') continue;
    for (const key of Object.keys(sectionData)) {
      keys.push(`${section}.${key}`);
    }
  }
  return keys;
}

function summarizePossessed(section: string, updates: SoulMemoryUpdate): string {
  const sectionData = updates[section as keyof SoulMemoryUpdate];
  if (!sectionData) return section;
  const keys = Object.keys(sectionData).filter(
    (k) => sectionData[k as keyof typeof sectionData] !== undefined,
  );
  return keys.length > 0 ? keys.map((k) => `${section}.${k}`).join(', ') : section;
}

function summarizeChange(section: string, updates: SoulMemoryUpdate): string {
  if (section === 'user' && updates.user) {
    if (updates.user.name) return `user name is ${updates.user.name}`;
    if (updates.user.preferences?.length)
      return `user prefers: ${updates.user.preferences.join(', ')}`;
    if (updates.user.languages?.length) return `user speaks: ${updates.user.languages.join(', ')}`;
    if (updates.user.expertise?.length)
      return `user expertise: ${updates.user.expertise.join(', ')}`;
    return 'updated user profile';
  }
  if (section === 'self' && updates.self) {
    if (updates.self.learnings?.length) return `learned: ${updates.self.learnings.join(', ')}`;
    if (updates.self.personality) return `personality: ${updates.self.personality}`;
    return 'updated self-knowledge';
  }
  if (section === 'context' && updates.context) {
    if (updates.context.activeWork) return `working on: ${updates.context.activeWork}`;
    return 'updated context';
  }
  return `updated ${section}`;
}
