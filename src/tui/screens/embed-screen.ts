import { storeDurableMemory } from '../../infra/memory/durable-memory.js';
import { embedSearch, embedSearchTuned } from '../../infra/storage/rust-embed-adapter.js';

export async function embedStoreScreen(id: string, value: string): Promise<string> {
  const out = await storeDurableMemory({
    memoryId: id,
    content: value,
    source: 'tui-embed',
    tags: ['operator-memory'],
  });
  const provider = out.embed?.provider ?? 'n/a';
  return `memory stored: id=${out.memoryId} journal_index=${out.index} indexed=${String(out.indexed)} provider=${provider}`;
}

export function embedSearchScreen(query: string, topK: number, tuned: boolean): string {
  const out = tuned
    ? embedSearchTuned(query, topK, process.env)
    : embedSearch(query, topK, process.env);
  const lines = [`embed results: ${out.count} for query="${query}"`];
  for (const hit of out.hits) {
    lines.push(`- ${hit.id} score=${hit.score.toFixed(4)} ${hit.text_preview}`);
  }
  return lines.join('\n');
}
