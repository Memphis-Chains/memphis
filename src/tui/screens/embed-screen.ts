import { embedSearch, embedSearchTuned, embedStore } from '../../infra/storage/rust-embed-adapter.js';

export function embedStoreScreen(id: string, value: string): string {
  const out = embedStore(id, value, process.env);
  return `embed stored: id=${out.id} count=${out.count} dim=${out.dim} provider=${out.provider}`;
}

export function embedSearchScreen(query: string, topK: number, tuned: boolean): string {
  const out = tuned ? embedSearchTuned(query, topK, process.env) : embedSearch(query, topK, process.env);
  const lines = [`embed results: ${out.count} for query="${query}"`];
  for (const hit of out.hits) {
    lines.push(`- ${hit.id} score=${hit.score.toFixed(4)} ${hit.text_preview}`);
  }
  return lines.join('\n');
}
