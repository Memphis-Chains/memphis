/**
 * The postmortem corpus, read the way a tool reads it.
 *
 * WHY THIS CONTRACT EXISTS
 * ------------------------
 * `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` §1 H8 measured it: eleven
 * documents, the index listed three of them, and not one of the eleven
 * carried a status a program could read. The answer to "what is still
 * open?" had to be assembled by reading eleven files by hand — and a
 * hand assembly rots exactly the way the index rotted.
 *
 * So every postmortem now carries a header a program can read, and the
 * `Open items` count in that header is a CLAIM THE DOCUMENT MAKES ABOUT
 * ITSELF. This test file is what checks that claim against the boxes.
 *
 * The interesting cases are the dishonest ones. A parser that counts
 * boxes happily reports a number for a document whose header says
 * something else, and the corpus then reports a lie as a fact.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPEN_ITEMS_HEADING,
  POSTMORTEM_STATUSES,
  parseOpenItems,
  parsePostmortemEntry,
  parsePostmortemHeader,
  readPostmortemCorpus,
  renderPostmortemIndex,
} from '../../src/infra/audit/postmortem-corpus.js';

describe('postmortem corpus · the header a program can read', () => {
  it('reads status, severity and the declared open-item count', () => {
    const header = parsePostmortemHeader(
      [
        '# Title',
        '',
        '**Status:** open',
        '**Severity:** S1 (runtime down)',
        '**Open items:** 7',
      ].join('\n'),
    );
    expect(header.status).toBe('open');
    expect(header.severity).toBe('S1 (runtime down)');
    expect(header.declaredOpenItems).toBe(7);
  });

  it('treats a status outside the vocabulary as ABSENT, not as a status', () => {
    // A program cannot act on a word it does not know. Reporting
    // "monitoring-forever" as a status would let a document through the
    // audit that the operator cannot act on.
    const header = parsePostmortemHeader('**Status:** monitoring-forever');
    expect(header.status).toBeNull();
  });

  it('reads every status the vocabulary declares', () => {
    for (const status of POSTMORTEM_STATUSES) {
      expect(parsePostmortemHeader(`**Status:** ${status}`).status).toBe(status);
    }
  });

  it('reads a status case-insensitively, because the corpus is hand-written', () => {
    expect(parsePostmortemHeader('**Status:** Resolved').status).toBe('resolved');
  });

  it('reports no status when the document declares none', () => {
    const header = parsePostmortemHeader('# Title\n\nIt was fixed at some point.');
    expect(header.status).toBeNull();
    expect(header.severity).toBeNull();
    expect(header.declaredOpenItems).toBeNull();
  });
});

describe('postmortem corpus · the open items it counts', () => {
  it('counts the unchecked boxes under the Open items heading', () => {
    const text = [
      '## Open items',
      '',
      '- [ ] **A1.** Something',
      '- [ ] **A2.** Something else',
      '- [x] **A3.** Already done',
      '',
      '## Open questions',
      '',
      '- [ ] not an open item, it is under another heading',
    ].join('\n');
    expect(parseOpenItems(text)).toEqual(['**A1.** Something', '**A2.** Something else']);
  });

  it('ignores boxes outside the Open items section', () => {
    // The 2026-09-22 incident lists twelve action items in "Lessons
    // learned" that are mostly closed. Those are history, not open work,
    // and counting them would make the corpus say the opposite of the
    // truth.
    const text = [
      '## Lessons learned',
      '',
      '- [ ] A1.',
      '- [ ] A2.',
      '',
      OPEN_ITEMS_HEADING,
      '',
      '- [ ] B1.',
    ].join('\n');
    expect(parseOpenItems(text)).toEqual(['B1.']);
  });

  it('returns nothing when the document has no Open items section', () => {
    expect(parseOpenItems('# Title\n\nNo section here.')).toEqual([]);
  });
});

describe('postmortem corpus · a document that contradicts itself', () => {
  it('does not detect inconsistency in the entry itself — the corpus does', () => {
    // parsePostmortemEntry is a pure parse. The comparison against the
    // declared count happens in readPostmortemCorpus, which is where the
    // corpus is assembled.
    const entry = parsePostmortemEntry(
      'x.md',
      '**Status:** open\n**Open items:** 5\n\n## Open items\n\n- [ ] one\n',
      'x.md',
    );
    expect(entry.header.declaredOpenItems).toBe(5);
    expect(entry.openItems).toHaveLength(1);
  });
});

describe('postmortem corpus · reading a whole corpus', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'memphis-postmortems-'));
    await mkdir(path.join(root, 'docs', 'postmortems'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (name: string, text: string): Promise<void> => {
    await writeFile(path.join(root, 'docs', 'postmortems', name), text, 'utf8');
  };

  it('reports a document whose header count contradicts its own boxes', async () => {
    await write(
      'liar.md',
      ['**Status:** open', '**Open items:** 5', '', '## Open items', '', '- [ ] only one', ''].join(
        '\n',
      ),
    );
    const corpus = await readPostmortemCorpus(root);
    expect(corpus?.inconsistent).toHaveLength(1);
    expect(corpus?.inconsistent[0]?.file).toBe('liar.md');
    expect(corpus?.inconsistent[0]?.reason).toContain('header says 5');
  });

  it('reports a document that claims to be resolved while boxes remain', async () => {
    await write(
      'resolved-but-open.md',
      [
        '**Status:** resolved',
        '**Open items:** 2',
        '',
        '## Open items',
        '',
        '- [ ] a',
        '- [ ] b',
        '',
      ].join('\n'),
    );
    const corpus = await readPostmortemCorpus(root);
    expect(corpus?.inconsistent[0]?.reason).toContain('resolved');
  });

  it('reports a document that claims to be open while listing nothing', async () => {
    await write('open-but-empty.md', ['**Status:** open', '**Open items:** 0', ''].join('\n'));
    const corpus = await readPostmortemCorpus(root);
    expect(corpus?.inconsistent[0]?.reason).toContain('lists no open item');
  });

  it('accepts a document whose header agrees with its boxes', async () => {
    await write(
      'honest.md',
      [
        '**Status:** open',
        '**Open items:** 2',
        '',
        '## Open items',
        '',
        '- [ ] a',
        '- [ ] b',
        '',
      ].join('\n'),
    );
    const corpus = await readPostmortemCorpus(root);
    expect(corpus?.inconsistent).toHaveLength(0);
    expect(corpus?.machineReadable).toBe(1);
    expect(corpus?.total).toBe(1);
  });

  it('names the documents that carry no readable status', async () => {
    await write('prose.md', '# It was resolved at some point.\n');
    const corpus = await readPostmortemCorpus(root);
    expect(corpus?.withoutStatus).toEqual(['prose.md']);
    expect(corpus?.machineReadable).toBe(0);
  });

  it('knows which documents the index lists', async () => {
    await write('listed.md', '**Status:** resolved\n');
    await write('unlisted.md', '**Status:** resolved\n');
    await writeFile(
      path.join(root, 'docs', 'postmortems', 'README.md'),
      'See [listed.md](listed.md).\n',
      'utf8',
    );
    const corpus = await readPostmortemCorpus(root);
    expect(corpus?.indexed).toBe(1);
    expect(corpus?.entries.find((e) => e.file === 'listed.md')?.indexed).toBe(true);
    expect(corpus?.entries.find((e) => e.file === 'unlisted.md')?.indexed).toBe(false);
  });

  it('returns null when there is no repository — a corpus that was not read is not a clean corpus', async () => {
    expect(await readPostmortemCorpus(null)).toBeNull();
  });
});

describe('postmortem corpus · the index it renders', () => {
  it('renders one row per document, ordered by file name', () => {
    const entries = [
      {
        file: '2026-10-02-b.md',
        header: { status: 'open', severity: 'S2', declaredOpenItems: 1 },
        openItems: ['x'],
        indexed: true,
      },
      {
        file: '2026-01-01-a.md',
        header: { status: 'resolved', severity: 'S1', declaredOpenItems: 0 },
        openItems: [],
        indexed: true,
      },
    ];
    const table = renderPostmortemIndex(entries);
    const lines = table.split('\n');
    expect(lines[0]).toContain('| File | Date | Severity | Status | Open items |');
    expect(table.indexOf('2026-01-01-a.md')).toBeLessThan(table.indexOf('2026-10-02-b.md'));
    expect(table).toContain('| 1 |');
    // A document with no open items says so with a dash, not with a 0
    // that reads like a measurement.
    expect(table).toContain('| — |');
  });

  it('marks a document with no readable status as unreadable rather than guessing', () => {
    const table = renderPostmortemIndex([
      {
        file: 'x.md',
        header: { status: null, severity: null, declaredOpenItems: null },
        openItems: [],
        indexed: false,
      },
    ]);
    expect(table).toContain('unreadable');
  });
});
