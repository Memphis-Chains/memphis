import { appendBlock } from '../../infra/storage/chain-adapter.js';
import { embedStore } from '../../infra/storage/rust-embed-adapter.js';

export type MemphisJournalInput = {
  content: string;
  tags?: string[];
};

export type MemphisJournalOutput = {
  success: boolean;
  index: number;
  hash: string;
  indexed: boolean;
};

export type JournalDeps = {
  append: typeof appendBlock;
  index: typeof embedStore;
};

const defaultDeps: JournalDeps = { append: appendBlock, index: embedStore };

export async function runMemphisJournal(
  input: MemphisJournalInput,
  deps: JournalDeps = defaultDeps,
): Promise<MemphisJournalOutput> {
  const block = await deps.append('journal', {
    content: input.content,
    tags: input.tags ?? [],
    source: 'mcp',
  });

  // Index into Rust embeddings for semantic recall
  let indexed = false;
  try {
    deps.index(`journal-${String(block.index)}`, input.content);
    indexed = true;
  } catch {
    // Embeddings are best-effort — chain write is the source of truth
  }

  return {
    success: true,
    index: block.index,
    hash: block.hash,
    indexed,
  };
}
