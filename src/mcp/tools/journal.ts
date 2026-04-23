import { storeDurableMemory } from '../../infra/memory/durable-memory.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';

export type MemphisJournalInput = {
  content: string;
  tags?: string[];
  /**
   * Caller surface for consent resolution. Defaults to 'mcp' for legacy
   * MCP-server callers; in-process chat memory clients pass 'cli.chat',
   * HTTP chat paths pass 'http.chat', telegram passes 'telegram', etc.
   * Routed through `resolveConsent` in durable-memory.ts so that
   * MEMPHIS_SURFACE_<SURFACE>_DEFAULT_CONSENT overrides take effect per
   * caller rather than being flattened to a single 'mcp' bucket.
   */
  surface?: string;
};

export type MemphisJournalOutput = {
  success: boolean;
  memoryId: string;
  index: number;
  hash: string;
  indexed: boolean;
  error?: string;
  patternId?: string;
};

export type JournalDeps = {
  store: typeof storeDurableMemory;
};

const defaultDeps: JournalDeps = { store: storeDurableMemory };

export async function runMemphisJournal(
  input: MemphisJournalInput,
  deps: JournalDeps = defaultDeps,
): Promise<MemphisJournalOutput> {
  const scan = scanContent(input.content, 'memory');
  if (!scan.allowed) {
    await emitRuntimeSecurityEvent({
      action: 'content_scan.journal.blocked',
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
      memoryId: '',
      index: 0,
      hash: '',
      indexed: false,
      error: `Blocked journal content: ${scan.reason}`,
      patternId: scan.patternId,
    };
  }

  return deps.store({
    content: input.content,
    tags: input.tags,
    source: 'mcp',
    // Route surface through resolveConsent so MEMPHIS_SURFACE_<SURFACE>_
    // DEFAULT_CONSENT overrides apply per caller. Default 'mcp' kept for
    // MCP-server writes; in-process chat/HTTP callers override explicitly.
    surface: input.surface ?? 'mcp',
  });
}
