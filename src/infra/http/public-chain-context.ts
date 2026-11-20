import { stat } from 'node:fs/promises';

import { getReadableChainPaths } from '../../config/paths.js';
import { runMemphisClassify } from '../../mcp/tools/classify.js';
import type { Block } from '../../memory/chain.js';
import { scanContent } from '../../security/content-scan.js';
import { getRecentBlocks } from '../storage/rust-chain-adapter.js';

const chains = ['journal', 'decisions', 'insights'];
export async function publicBasalReady(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const url = new URL(env.MEMPHIS_PUBLIC_BASAL_URL || 'http://127.0.0.1:8000/v1/systemone');
    if (
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const res = await fetch(new URL('/health', url), {
      redirect: 'error',
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return false;
    const result = await res.json();
    return result.status === 'ok' || (result.ok === true && result.ready === true);
  } catch {
    return false;
  }
}
type PublicNote = { chain: string; index: number; hash: string; text: string };
export type PublicClassification = {
  model: string | null;
  route: 'general' | 'clarify' | 'memory';
  source?: PublicNote;
};

export function publicNotesFromBlocks(blocks: Block[]): PublicNote[] {
  const annotations = blocks
    .filter((b) => b.chain === 'journal' && b.data?.kind === 'consent.annotation')
    .sort((a, b) => (b.index ?? -1) - (a.index ?? -1));
  const notes: PublicNote[] = [];
  for (const block of blocks) {
    const { chain, index, hash, data } = block;
    if (
      !chain ||
      !chains.includes(chain) ||
      typeof index !== 'number' ||
      !hash ||
      data?.consent !== 'exportable' ||
      !Array.isArray(data.tags) ||
      !data.tags.includes('public-chat') ||
      typeof data.content !== 'string' ||
      !data.content.trim() ||
      !scanContent(data.content, 'memory').allowed
    )
      continue;
    const change = annotations.find(
      ({ data: a }) =>
        a?.target_chain === chain &&
        typeof a.from_index === 'number' &&
        typeof a.to_index === 'number' &&
        a.from_index <= index &&
        index <= a.to_index,
    );
    if (change && change.data?.level !== 'exportable') continue;
    notes.push({
      chain,
      index,
      hash,
      text: Array.from(data.content.trim()).slice(0, 240).join(''),
    });
  }
  return notes;
}

// A new block, including a consent annotation, changes its directory's timestamp.
// Cache only publishable excerpts. Never reuse a cached catalog after an I/O failure.
let catalog: { version: string; pending: Promise<PublicNote[]> } | undefined;
async function currentPublicNotes(): Promise<PublicNote[]> {
  const dirs = chains.flatMap((chain) => getReadableChainPaths(chain));
  const versions = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return dir + ':' + (await stat(dir, { bigint: true })).mtimeNs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return dir + ':absent';
        throw err;
      }
    }),
  );
  const version = JSON.stringify(versions);
  if (catalog?.version === version) return catalog.pending;
  const pending = Promise.all(
    chains.map((chain) => getRecentBlocks(chain, Number.MAX_SAFE_INTEGER)),
  ).then((blocks) => publicNotesFromBlocks(blocks.flat()));
  catalog = { version, pending };
  try {
    return await pending;
  } catch (err) {
    if (catalog?.pending === pending) catalog = undefined;
    throw err;
  }
}

export async function classifyPublicQuestion(
  question: string,
  readNotes = currentPublicNotes,
  classify = runMemphisClassify,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicClassification | null> {
  const notes = await readNotes();
  const terms = [
    ...new Set(
      (question.toLocaleLowerCase('pl').match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((t) =>
        t.slice(0, 5),
      ),
    ),
  ];
  const best = notes
    .map((note) => {
      const text = note.text.toLocaleLowerCase('pl');
      return { note, score: terms.filter((term) => text.includes(term)).length };
    })
    .sort((a, b) => b.score - a.score || b.note.index - a.note.index)[0];
  const selected = best?.score > 0 ? best.note : undefined;
  const input = selected
    ? {
        state: 'Pytanie użytkownika: ' + question + '\nFragment pamięci: ' + selected.text,
        question: 'Czy fragment zawiera informację potrzebną do odpowiedzi na to pytanie?',
        criteria: {
          yes: 'Tak, fragment odpowiada na pytanie.',
          no: 'Nie, fragment nie zawiera odpowiedzi.',
        },
      }
    : {
        state: question,
        question: 'Czy pytanie wymaga doprecyzowania?',
        criteria: {
          yes: 'Tak, brakuje ważnej informacji.',
          no: 'Nie, można od razu odpowiedzieć.',
        },
      };
  // This is a relevance cutoff for already public text; consent is checked independently.
  const result = await classify(
    { ...input, type: 'choice', orders: 1, threshold: 0.65 },
    { MEMPHIS_BASAL_URL: env.MEMPHIS_PUBLIC_BASAL_URL },
    { localOnly: true, timeoutMs: 45_000 },
  );
  if (!result.ok) return null;
  const outcome: PublicClassification = { model: result.model, route: 'general' };
  if (!result.auto || result.choice !== 'yes') return outcome;
  if (!selected) return { ...outcome, route: 'clarify' };
  // Consent can change while a CPU inference is running. Recheck the exact block at disclosure.
  const current = (await readNotes()).find(
    (n) => n.chain === selected.chain && n.index === selected.index && n.hash === selected.hash,
  );
  return current ? { ...outcome, route: 'memory', source: current } : outcome;
}
