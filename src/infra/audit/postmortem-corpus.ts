/**
 * The postmortem corpus, read the way a tool reads it.
 *
 * WHAT THIS IS FOR
 * -----------------
 * `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` §1 H8: "The postmortem
 * corpus cannot answer 'what is still open?'". Measured on 2026-11-10:
 * eleven documents, the index listed three of them, and not one of the
 * eleven carried a status a program could read. Statuses were prose
 * ("Resolved", "fixed", "open"), so the answer to "what is still open"
 * had to be assembled by reading eleven files by hand — and a hand
 * assembly rots exactly the way the index rotted.
 *
 * So every postmortem now carries a header a program can read:
 *
 *     **Status:** open
 *     **Severity:** HIGH
 *     **Open items:** 7
 *
 * `Status` is a closed vocabulary. `Open items` is the count of
 * unchecked boxes in the document's own "Open items" section — the
 * number is therefore a CLAIM THE DOCUMENT MAKES ABOUT ITSELF, and
 * this module checks the claim against the boxes. A document whose
 * header says "0 open items" while the section lists seven boxes is a
 * document that lies, and the audit says so.
 *
 * WHY NOT YAML FRONT MATTER
 * --------------------------
 * The corpus is prose written by hand over five months, in two
 * languages, with shapes that differ from document to document. Front
 * matter would have been a second document format to keep in sync
 * with a header block that already sits in every one of them.
 *
 * WHY THE VOCABULARY IS CLOSED
 * -----------------------------
 * An open vocabulary is a prose field with extra steps: a program
 * cannot tell "monitoring" from "under observation" from "will watch",
 * and the audit would pass a document whose status it did not
 * understand. A status the audit cannot interpret is a status the
 * operator cannot act on, so the audit treats it as missing.
 *
 * `monitoring` exists because "fixed but watched" is a real state and
 * collapsing it into `resolved` would overstate what we know, while
 * calling it `open` would overstate what is broken.
 */

/** The statuses a postmortem may declare. */
export const POSTMORTEM_STATUSES = ['resolved', 'open', 'monitoring'] as const;

export type PostmortemStatus = (typeof POSTMORTEM_STATUSES)[number];

/** The heading under which the still-open items of a document live. */
export const OPEN_ITEMS_HEADING = '## Open items';

export interface PostmortemHeader {
  /** The declared status, or null when the document declares none. */
  readonly status: PostmortemStatus | null;
  /** The declared severity, or null. Free text — the corpus is prose. */
  readonly severity: string | null;
  /** The declared count of open items, or null when the header omits it. */
  readonly declaredOpenItems: number | null;
}

export interface PostmortemEntry {
  /** File name inside `docs/postmortems/`. */
  readonly file: string;
  readonly header: PostmortemHeader;
  /** Unchecked boxes in the document's "Open items" section. */
  readonly openItems: readonly string[];
  /** Whether the index in `README.md` lists this document. */
  readonly indexed: boolean;
}

export interface PostmortemCorpus {
  readonly entries: readonly PostmortemEntry[];
  readonly total: number;
  /** Documents whose status a program can read. */
  readonly machineReadable: number;
  /** Documents listed in the index. */
  readonly indexed: number;
  /** Documents whose header contradicts their own open-items section. */
  readonly inconsistent: readonly { readonly file: string; readonly reason: string }[];
  /** Documents with no readable status. */
  readonly withoutStatus: readonly string[];
}

const STATUS_LINE = /^\*\*Status:\*\*\s*([A-Za-z-]+)\s*$/im;
const SEVERITY_LINE = /^\*\*Severity:\*\*\s*(.+?)\s*$/im;
const OPEN_ITEMS_COUNT_LINE = /^\*\*Open items:\*\*\s*(\d+)\s*$/im;

/**
 * Read the header block of a postmortem.
 *
 * A status outside the vocabulary is reported as absent, not as a
 * status. The caller cannot act on a word it does not know, so
 * pretending the document has a status would be the same lie in a
 * different shape.
 */
export function parsePostmortemHeader(text: string): PostmortemHeader {
  const statusMatch = STATUS_LINE.exec(text);
  const severityMatch = SEVERITY_LINE.exec(text);
  const countMatch = OPEN_ITEMS_COUNT_LINE.exec(text);

  const raw = statusMatch?.[1]?.toLowerCase() ?? null;
  const status =
    raw && (POSTMORTEM_STATUSES as readonly string[]).includes(raw)
      ? (raw as PostmortemStatus)
      : null;

  return {
    status,
    severity: severityMatch?.[1] ?? null,
    declaredOpenItems: countMatch ? Number(countMatch[1]) : null,
  };
}

/**
 * The still-open items of a document: the unchecked boxes under its
 * "Open items" heading.
 *
 * Boxes outside that section are ignored on purpose. A document may
 * carry a checklist of things that were done (the 2026-09-22 incident
 * lists twelve action items, most of them closed) — those are history,
 * not open work, and counting them as open would make the corpus say
 * the opposite of the truth.
 */
export function parseOpenItems(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === OPEN_ITEMS_HEADING);
  if (start === -1) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const match = /^\s*[-*]\s*\[ \]\s*(.+?)\s*$/.exec(line);
    if (match) items.push(match[1]);
  }
  return items;
}

/**
 * Parse one document of the corpus.
 *
 * `indexed` says whether `README.md` names the file — the index is
 * the second half of the rot the plan measured (three of eleven
 * listed), and a document nobody can find is a document nobody reads.
 */
export function parsePostmortemEntry(
  file: string,
  text: string,
  indexText: string,
): PostmortemEntry {
  return {
    file,
    header: parsePostmortemHeader(text),
    openItems: parseOpenItems(text),
    indexed: indexText.includes(file),
  };
}

/**
 * Read the whole corpus from a repository root.
 *
 * Returns null when there is no repository — the caller then reports
 * `unknown`, never `success`. A corpus that was not read is not a
 * clean corpus.
 */
export async function readPostmortemCorpus(
  repoRoot: string | null,
): Promise<PostmortemCorpus | null> {
  if (!repoRoot) return null;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const dir = path.join(repoRoot, 'docs', 'postmortems');
  const names = (await fs.readdir(dir).catch(() => [])).filter(
    (name) => name.endsWith('.md') && name !== 'README.md',
  );
  const indexText = (await fs.readFile(path.join(dir, 'README.md'), 'utf8').catch(() => '')) ?? '';

  const entries: PostmortemEntry[] = [];
  for (const name of names) {
    const text = (await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')) ?? '';
    entries.push(parsePostmortemEntry(name, text, indexText));
  }

  const inconsistent: { file: string; reason: string }[] = [];
  const withoutStatus: string[] = [];
  let machineReadable = 0;
  let indexed = 0;

  for (const entry of entries) {
    if (entry.header.status) machineReadable += 1;
    else withoutStatus.push(entry.file);
    if (entry.indexed) indexed += 1;

    const declared = entry.header.declaredOpenItems;
    if (declared !== null && declared !== entry.openItems.length) {
      inconsistent.push({
        file: entry.file,
        reason: `header says ${declared} open item(s), the section lists ${entry.openItems.length}`,
      });
    }
    if (entry.header.status === 'resolved' && entry.openItems.length > 0) {
      inconsistent.push({
        file: entry.file,
        reason: `status is "resolved" but ${entry.openItems.length} item(s) are still open`,
      });
    }
    if (entry.header.status === 'open' && entry.openItems.length === 0) {
      inconsistent.push({
        file: entry.file,
        reason: 'status is "open" but the document lists no open item',
      });
    }
  }

  return {
    entries,
    total: entries.length,
    machineReadable,
    indexed,
    inconsistent,
    withoutStatus,
  };
}

/**
 * The index table, rendered from the corpus.
 *
 * One row per document, ordered by file name so the table does not
 * churn between regenerations. The generator writes between the
 * `<!-- postmortem-index:start -->` and `<!-- postmortem-index:end -->`
 * markers in `docs/postmortems/README.md`.
 */
export function renderPostmortemIndex(entries: readonly PostmortemEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => {
      const date = /^(\d{4}-\d{2}-\d{2})/.exec(entry.file)?.[1] ?? '';
      const severity = entry.header.severity ?? '—';
      const status = entry.header.status ?? 'unreadable';
      const open = entry.openItems.length;
      const openCell = open === 0 ? '—' : String(open);
      return `| [${entry.file}](${entry.file}) | ${date} | ${severity} | ${status} | ${openCell} |`;
    });

  return [
    '| File | Date | Severity | Status | Open items |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}
