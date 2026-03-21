import { storeDurableMemory } from '../../infra/memory/durable-memory.js';

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
};

export type JournalDeps = {
  store: typeof storeDurableMemory;
};

const defaultDeps: JournalDeps = { store: storeDurableMemory };

export async function runMemphisJournal(
  input: MemphisJournalInput,
  deps: JournalDeps = defaultDeps,
): Promise<MemphisJournalOutput> {
  return deps.store({
    content: input.content,
    tags: input.tags,
    source: 'mcp',
  });
}
