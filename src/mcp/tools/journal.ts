import { appendBlock } from '../../infra/storage/chain-adapter.js';

export type MemphisJournalInput = {
  content: string;
  tags?: string[];
};

export type MemphisJournalOutput = {
  success: boolean;
  index: number;
  hash: string;
};

export type JournalDeps = {
  append: typeof appendBlock;
};

export async function runMemphisJournal(
  input: MemphisJournalInput,
  deps: JournalDeps = { append: appendBlock },
): Promise<MemphisJournalOutput> {
  const block = await deps.append('journal', {
    content: input.content,
    tags: input.tags ?? [],
    source: 'mcp',
  });

  return {
    success: true,
    index: block.index,
    hash: block.hash,
  };
}
