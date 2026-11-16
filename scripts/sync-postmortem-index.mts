/**
 * Regenerate the postmortem index from the corpus.
 *
 * WHY A GENERATOR
 * ---------------
 * The index in `docs/postmortems/README.md` listed three of eleven
 * documents and was dated 2026-09-26. A hand-maintained index of a
 * corpus that grows is an index that rots — and a document nobody can
 * find is a document nobody reads, which is the same hole as a
 * document nobody can measure.
 *
 * The table is therefore derived from the documents themselves: one row
 * per postmortem, with the status and open-item count the document
 * declares. The generator writes between two markers, so the prose
 * around the table is untouched.
 *
 * USAGE
 * -----
 *   npm run -s ops:sync-postmortem-index          # write
 *   npm run -s ops:sync-postmortem-index -- --check  # fail if stale
 *
 * `--check` is what CI runs: it exits non-zero when the file on disk
 * differs from what the corpus says. A generator nobody runs is a
 * generator that drifts.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readPostmortemCorpus,
  renderPostmortemIndex,
} from '../src/infra/audit/postmortem-corpus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'docs', 'postmortems', 'README.md');
const START = '<!-- postmortem-index:start -->';
const END = '<!-- postmortem-index:end -->';

const checkOnly = process.argv.includes('--check');

const corpus = await readPostmortemCorpus(ROOT);
if (!corpus) {
  console.error('[postmortem-index] no repository root');
  process.exit(1);
}

const table = renderPostmortemIndex(corpus.entries);

const current = await readFile(README, 'utf8');
const startAt = current.indexOf(START);
const endAt = current.indexOf(END);
if (startAt === -1 || endAt === -1 || endAt < startAt) {
  console.error(
    `[postmortem-index] README.md is missing the markers ${START} / ${END} — refusing to guess where the table goes`,
  );
  process.exit(1);
}

const next = current.slice(0, startAt + START.length) + '\n' + table + '\n' + current.slice(endAt);

if (next === current) {
  console.log(`[postmortem-index] OK (${corpus.total} document(s), index in sync)`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    '[postmortem-index] STALE: the index does not match the corpus. Run `npm run -s ops:sync-postmortem-index`.',
  );
  process.exit(1);
}

await writeFile(README, next, 'utf8');
console.log(
  `[postmortem-index] wrote ${corpus.total} row(s) (${corpus.indexed} indexed, ${corpus.machineReadable} with a readable status)`,
);
