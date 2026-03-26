import type Database from 'better-sqlite3';

export interface ExactSearchIndexEntryInput {
  sourceKey: string;
  chain: string;
  blockIndex: number;
  blockHash: string;
  blockType: string;
  content: string;
  summary: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  indexedAt?: string;
}

export interface ExactSearchHit {
  sourceKey: string;
  chain: string;
  blockIndex: number;
  blockHash: string;
  blockType: string;
  content: string;
  summary: string;
  snippet: string;
  tags: string[];
  metadata: Record<string, unknown>;
  score: number;
  indexedAt: string;
}

type SearchRow = {
  source_key: string;
  chain_name: string;
  block_index: number;
  block_hash: string;
  block_type: string;
  content: string;
  summary: string;
  tags_json: string;
  metadata_json: string;
  indexed_at: string;
  snippet: string | null;
  rank: number;
};

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizePhraseQuery(query: string): string {
  return `"${query.trim().replace(/"/g, '""')}"`;
}

function normalizeScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  if (rank <= 0) {
    return Number((1 / (1 + Math.abs(rank))).toFixed(6));
  }
  return Number((1 / (1 + rank)).toFixed(6));
}

export class SqliteMemorySearchRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(entry: ExactSearchIndexEntryInput): void {
    const indexedAt = entry.indexedAt ?? new Date().toISOString();
    const tags = Array.from(new Set(entry.tags.map((tag) => tag.trim()).filter(Boolean)));
    const tagsJson = JSON.stringify(tags);
    const tagsText = tags.join(' ');
    const metadataJson = JSON.stringify(entry.metadata ?? {});

    const existing = this.db
      .prepare('SELECT id FROM memory_search_entries WHERE source_key = ?')
      .get(entry.sourceKey) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE memory_search_entries
           SET chain_name = ?, block_index = ?, block_hash = ?, block_type = ?, content = ?,
               summary = ?, tags_json = ?, tags_text = ?, metadata_json = ?, indexed_at = ?
           WHERE id = ?`,
        )
        .run(
          entry.chain,
          entry.blockIndex,
          entry.blockHash,
          entry.blockType,
          entry.content,
          entry.summary,
          tagsJson,
          tagsText,
          metadataJson,
          indexedAt,
          existing.id,
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO memory_search_entries (
           source_key,
           chain_name,
           block_index,
           block_hash,
           block_type,
           content,
           summary,
           tags_json,
           tags_text,
           metadata_json,
           indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sourceKey,
        entry.chain,
        entry.blockIndex,
        entry.blockHash,
        entry.blockType,
        entry.content,
        entry.summary,
        tagsJson,
        tagsText,
        metadataJson,
        indexedAt,
      );
  }

  search(query: string, limit = 10, chain?: string): ExactSearchHit[] {
    const phrase = normalizePhraseQuery(query);
    const safeLimit = Math.max(1, Math.min(limit, 100));

    const baseSql = `
      SELECT
        e.source_key,
        e.chain_name,
        e.block_index,
        e.block_hash,
        e.block_type,
        e.content,
        e.summary,
        e.tags_json,
        e.metadata_json,
        e.indexed_at,
        snippet(memory_search_fts, 0, '[', ']', ' ... ', 12) AS snippet,
        bm25(memory_search_fts, 5.0, 1.2, 2.0) AS rank
      FROM memory_search_fts
      JOIN memory_search_entries e ON memory_search_fts.rowid = e.id
      WHERE memory_search_fts MATCH ?
    `;

    const sql = chain
      ? `${baseSql} AND e.chain_name = ? ORDER BY rank ASC LIMIT ?`
      : `${baseSql} ORDER BY rank ASC LIMIT ?`;

    const rows = (chain
      ? this.db.prepare(sql).all(phrase, chain, safeLimit)
      : this.db.prepare(sql).all(phrase, safeLimit)) as SearchRow[];

    return rows.map((row) => ({
      sourceKey: row.source_key,
      chain: row.chain_name,
      blockIndex: row.block_index,
      blockHash: row.block_hash,
      blockType: row.block_type,
      content: row.content,
      summary: row.summary,
      snippet: row.snippet ?? row.summary,
      tags: parseStringArray(row.tags_json),
      metadata: parseObject(row.metadata_json),
      score: normalizeScore(row.rank),
      indexedAt: row.indexed_at,
    }));
  }

  clear(): void {
    this.db.prepare('DELETE FROM memory_search_entries').run();
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM memory_search_entries').get() as {
      count: number;
    };
    return row.count;
  }
}
