import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getReadableChainPaths } from '../../config/paths.js';
import { runMemphisClassify } from '../../mcp/tools/classify.js';
import type { Block } from '../../memory/chain.js';
import { scanContent } from '../../security/content-scan.js';
import { listBlockFiles, readBlockFile, type NapiBlock } from '../storage/chain-file-io.js';

const chains = ['journal', 'decisions', 'insights'];

/**
 * The chain that carries the consent annotations.
 *
 * Annotations are the operator's *downgrade* mark: they mark a range of
 * blocks as no longer exportable. They live in the journal, so the
 * journal is always scanned in full for them. Missing one would publish a
 * note the operator had revoked — so this is the one chain that is not
 * windowed.
 */
const ANNOTATION_CHAIN = 'journal';

/**
 * How many blocks of a non-journal chain the public catalog looks at.
 *
 * ## Why this number exists
 *
 * The public chat used to ask for `Number.MAX_SAFE_INTEGER` blocks from
 * three chains on every request. Measured on the operator's host:
 *
 * | chain     | blocks | on disk | public notes |
 * | --------- | ------ | ------- | ------------ |
 * | `journal` | 1056   | 1.8 MB  | 1            |
 * | `decisions` | 549  | 2.7 MB  | 0            |
 * | `insights` | 402   | 31.9 MB | 0            |
 *
 * Thirty-six megabytes of JSON, parsed into JavaScript objects on every
 * public request, to find one usable note. The parsed form is several
 * times larger than the bytes on disk, and the request path allows four
 * of them at a time — which is where the runtime's 9.6 GB memory peak
 * came from.
 *
 * The window is generous because a note the operator published for the
 * public chat is recent by nature, and because the journal — where the
 * notes actually live — is not windowed at all.
 */
const PUBLIC_CHAIN_TAIL_LIMIT = 1000;

type PublicNote = { chain: string; index: number; hash: string; text: string };

/**
 * A block that survived the cheap gates, reduced to the fields the
 * consent rules need.
 *
 * The reduction is the point: a block that is not a note and not an
 * annotation is dropped **before** its content is retained, so the
 * large payloads never accumulate.
 */
type PublicCandidate = {
  chain: string;
  index: number;
  hash: string;
  isAnnotation: boolean;
  content: string;
  targetChain?: string;
  fromIndex?: number;
  toIndex?: number;
  level?: string;
};

export type PublicClassification = {
  model: string | null;
  route: 'general' | 'clarify' | 'memory';
  source?: PublicNote;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Apply the cheap gates and reduce the block to what the consent rules
 * need.
 *
 * Returns `undefined` for every block that cannot possibly become a
 * public note. That is the majority of them, and it is what keeps the
 * memory flat: the payload of a rejected block is released as soon as
 * the block is parsed, not when the whole chain has been read.
 */
function reduceCandidate(chain: string, raw: NapiBlock): PublicCandidate | undefined {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const index = readNumber(raw.index) ?? -1;
  const hash = readString(raw.hash) ?? '';

  const isAnnotation = chain === ANNOTATION_CHAIN && data.kind === 'consent.annotation';
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const consent = readString(data.consent);
  const isNote = consent === 'exportable' && tags.includes('public-chat');

  // Neither gate passed: the block carries nothing this catalog can use.
  if (!isAnnotation && !isNote) return undefined;

  const candidate: PublicCandidate = {
    chain,
    index,
    hash,
    isAnnotation,
    // An annotation is metadata; its text is never published.
    content: isNote && typeof data.content === 'string' ? data.content : '',
  };
  if (isAnnotation) {
    candidate.targetChain = readString(data.target_chain);
    candidate.fromIndex = readNumber(data.from_index);
    candidate.toIndex = readNumber(data.to_index);
    candidate.level = readString(data.level);
  }
  return candidate;
}

/**
 * Read the candidates for the public catalog.
 *
 * One block is in memory at a time. The journal is read in full because
 * it carries the consent annotations; the other chains are windowed.
 */
async function readPublicCandidates(rawEnv: NodeJS.ProcessEnv): Promise<PublicCandidate[]> {
  const candidates: PublicCandidate[] = [];
  for (const chain of chains) {
    const windowed = chain !== ANNOTATION_CHAIN;
    for (const dir of getReadableChainPaths(chain, rawEnv)) {
      const files = await listBlockFiles(dir);
      // Block files are zero-padded and `listBlockFiles` sorts them
      // lexicographically, so the tail of the listing is the newest
      // blocks.
      const selected =
        windowed && files.length > PUBLIC_CHAIN_TAIL_LIMIT
          ? files.slice(-PUBLIC_CHAIN_TAIL_LIMIT)
          : files;
      for (const file of selected) {
        const raw = await readBlockFile<NapiBlock>(join(dir, file));
        const candidate = reduceCandidate(chain, raw);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

/**
 * Turn the reduced candidates into the publishable notes.
 *
 * The consent rules, unchanged:
 *
 * - a note is published only when it carries `consent=exportable` and the
 *   `public-chat` tag, and the content scan clears it;
 * - a consent annotation covering the note's index downgrades it, unless
 *   the annotation itself says `exportable`.
 */
export function publicNotesFromCandidates(candidates: PublicCandidate[]): PublicNote[] {
  const annotations = candidates
    .filter((candidate) => candidate.isAnnotation)
    .sort((a, b) => b.index - a.index);
  const notes: PublicNote[] = [];
  for (const candidate of candidates) {
    if (candidate.isAnnotation) continue;
    const { chain, index, hash, content } = candidate;
    if (
      !chain ||
      !chains.includes(chain) ||
      index < 0 ||
      !hash ||
      !content.trim() ||
      !scanContent(content, 'memory').allowed
    ) {
      continue;
    }
    const change = annotations.find(
      (annotation) =>
        annotation.targetChain === chain &&
        annotation.fromIndex !== undefined &&
        annotation.toIndex !== undefined &&
        annotation.fromIndex <= index &&
        index <= annotation.toIndex,
    );
    if (change && change.level !== 'exportable') continue;
    notes.push({
      chain,
      index,
      hash,
      text: Array.from(content.trim()).slice(0, 240).join(''),
    });
  }
  return notes;
}

/**
 * Kept for callers that already hold blocks in memory.
 *
 * The streaming reader above is the path the server uses; this one is
 * for tests and for a caller that has the blocks already.
 */
export function publicNotesFromBlocks(blocks: Block[]): PublicNote[] {
  const candidates: PublicCandidate[] = [];
  for (const block of blocks) {
    const chain = block.chain;
    const data = (block.data ?? {}) as Record<string, unknown>;
    const isAnnotation = chain === ANNOTATION_CHAIN && data.kind === 'consent.annotation';
    const tags = Array.isArray(data.tags)
      ? data.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const isNote = readString(data.consent) === 'exportable' && tags.includes('public-chat');
    if (!isAnnotation && !isNote) continue;
    candidates.push({
      chain: chain ?? '',
      index: readNumber(block.index) ?? -1,
      hash: readString(block.hash) ?? '',
      isAnnotation,
      content: isNote && typeof data.content === 'string' ? data.content : '',
      targetChain: readString(data.target_chain),
      fromIndex: readNumber(data.from_index),
      toIndex: readNumber(data.to_index),
      level: readString(data.level),
    });
  }
  return publicNotesFromCandidates(candidates);
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
  const pending = readPublicCandidates(process.env).then(publicNotesFromCandidates);
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
