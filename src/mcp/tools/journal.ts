import { storeDurableMemory } from '../../infra/memory/durable-memory.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';

export type MemphisJournalInput = {
  content: string;
  tags?: string[];
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
  });
}
