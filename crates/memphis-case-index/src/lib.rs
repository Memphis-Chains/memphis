use std::path::Path;

use chrono::Utc;
use memphis_core::block::{Block, BlockType};
use memphis_core::case_entry::{CaseEntry, CaseQuery};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS case_entries (
    block_index     INTEGER PRIMARY KEY,
    block_hash      TEXT NOT NULL,
    chain           TEXT NOT NULL DEFAULT 'cases',
    case_type       TEXT NOT NULL,
    entity          TEXT,
    actor           TEXT,
    target          TEXT,
    instrument      TEXT,
    location        TEXT,
    origin          TEXT,
    destination     TEXT,
    owner           TEXT,
    possessed       TEXT,
    giver           TEXT,
    recipient       TEXT,
    object          TEXT,
    subject         TEXT,
    verb            TEXT,
    invoker         TEXT,
    invocation      TEXT,
    entry_timestamp TEXT,
    full_json       TEXT NOT NULL,
    indexed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_type ON case_entries(case_type);
CREATE INDEX IF NOT EXISTS idx_case_entity ON case_entries(entity);
CREATE INDEX IF NOT EXISTS idx_case_actor ON case_entries(actor);
CREATE INDEX IF NOT EXISTS idx_case_target ON case_entries(target);
CREATE INDEX IF NOT EXISTS idx_case_instrument ON case_entries(instrument);
CREATE INDEX IF NOT EXISTS idx_case_timestamp ON case_entries(entry_timestamp);
CREATE INDEX IF NOT EXISTS idx_case_type_actor ON case_entries(case_type, actor);
CREATE INDEX IF NOT EXISTS idx_case_type_target ON case_entries(case_type, target);
"#;

/// A row returned from a case index query.
#[derive(Debug, Clone, Serialize)]
pub struct CaseIndexRow {
    pub block_index: u64,
    pub block_hash: String,
    pub chain: String,
    pub case_type: String,
    pub full_json: String,
    pub entry: CaseEntry,
}

/// Report from a rebuild operation.
#[derive(Debug, Clone, Serialize)]
pub struct RebuildReport {
    pub indexed: usize,
    pub skipped: usize,
    pub errors: usize,
}

/// SQLite-backed index for case-based chain entries.
/// This is a rebuildable cache — the chain files are the source of truth.
pub struct CaseIndex {
    conn: Connection,
}

impl CaseIndex {
    /// Opens (or creates) the SQLite case index at the given path.
    /// Creates parent directories if they don't exist.
    pub fn open(path: &Path) -> Result<Self, CaseIndexError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CaseIndexError::Io(format!(
                    "failed to create directory {}: {e}",
                    parent.display()
                ))
            })?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let idx = CaseIndex { conn };
        idx.init_schema()?;
        Ok(idx)
    }

    /// Opens an in-memory index (for testing).
    pub fn open_in_memory() -> Result<Self, CaseIndexError> {
        let conn = Connection::open_in_memory()?;
        let idx = CaseIndex { conn };
        idx.init_schema()?;
        Ok(idx)
    }

    fn init_schema(&self) -> Result<(), CaseIndexError> {
        self.conn.execute_batch(SCHEMA_SQL)?;
        Ok(())
    }

    /// Index a single block. Only indexes blocks with `BlockType::Case`.
    /// Silently skips non-case blocks.
    pub fn index_block(&self, block: &Block) -> Result<bool, CaseIndexError> {
        if !matches!(block.data.block_type, BlockType::Case) {
            return Ok(false);
        }

        let entry = CaseEntry::from_block_content(&block.data.content)
            .map_err(|e| CaseIndexError::Parse(format!("block {}: {e}", block.index)))?;

        let full_json = serde_json::to_string(&entry)
            .map_err(|e| CaseIndexError::Parse(format!("serialize: {e}")))?;

        let now = Utc::now().to_rfc3339();
        let ct = entry.case_type().as_str();

        // Extract denormalized fields
        let (entity, actor, target, instrument, location, origin, destination) =
            extract_common_fields(&entry);
        let (owner, possessed, giver, recipient, object, subject, verb, invoker, invocation) =
            extract_specific_fields(&entry);
        let entry_timestamp = extract_timestamp(&entry);

        self.conn.execute(
            "INSERT OR REPLACE INTO case_entries (
                block_index, block_hash, chain, case_type,
                entity, actor, target, instrument, location, origin, destination,
                owner, possessed, giver, recipient, object, subject, verb,
                invoker, invocation, entry_timestamp, full_json, indexed_at
            ) VALUES (
                ?1, ?2, ?3, ?4,
                ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21, ?22, ?23
            )",
            params![
                block.index as i64,
                block.hash,
                block.chain,
                ct,
                entity,
                actor,
                target,
                instrument,
                location,
                origin,
                destination,
                owner,
                possessed,
                giver,
                recipient,
                object,
                subject,
                verb,
                invoker,
                invocation,
                entry_timestamp,
                full_json,
                now,
            ],
        )?;

        Ok(true)
    }

    /// Query the index with optional filters.
    pub fn query(&self, q: &CaseQuery) -> Result<Vec<CaseIndexRow>, CaseIndexError> {
        let mut conditions = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref ct) = q.case_type {
            conditions.push("case_type = ?");
            param_values.push(Box::new(ct.as_str().to_string()));
        }
        if let Some(ref entity) = q.entity {
            conditions.push("entity = ?");
            param_values.push(Box::new(entity.clone()));
        }
        if let Some(ref actor) = q.actor {
            conditions.push("actor = ?");
            param_values.push(Box::new(actor.clone()));
        }
        if let Some(ref target) = q.target {
            conditions.push("target = ?");
            param_values.push(Box::new(target.clone()));
        }
        if let Some(ref instrument) = q.instrument {
            conditions.push("instrument = ?");
            param_values.push(Box::new(instrument.clone()));
        }
        if let Some(ref location) = q.location {
            conditions.push("location = ?");
            param_values.push(Box::new(location.clone()));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let limit_clause = match q.limit {
            Some(l) => format!(" LIMIT {l}"),
            None => String::new(),
        };

        let sql = format!(
            "SELECT block_index, block_hash, chain, case_type, full_json \
             FROM case_entries {where_clause} \
             ORDER BY block_index DESC{limit_clause}"
        );

        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            let full_json: String = row.get(4)?;
            let entry: CaseEntry = serde_json::from_str(&full_json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(CaseIndexRow {
                block_index: row.get::<_, i64>(0)? as u64,
                block_hash: row.get(1)?,
                chain: row.get(2)?,
                case_type: row.get(3)?,
                full_json,
                entry,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Rebuild the index from a set of blocks (e.g., read from chain files).
    /// Drops all existing data and re-indexes.
    pub fn rebuild(&self, blocks: &[Block]) -> Result<RebuildReport, CaseIndexError> {
        self.conn.execute("DELETE FROM case_entries", [])?;

        let mut indexed = 0;
        let mut skipped = 0;
        let mut errors = 0;

        for block in blocks {
            match self.index_block(block) {
                Ok(true) => indexed += 1,
                Ok(false) => skipped += 1,
                Err(_) => errors += 1,
            }
        }

        Ok(RebuildReport {
            indexed,
            skipped,
            errors,
        })
    }

    /// Returns the highest block_index that has been indexed, or None if empty.
    pub fn last_indexed_block(&self) -> Result<Option<u64>, CaseIndexError> {
        let result: Option<i64> = self
            .conn
            .query_row("SELECT MAX(block_index) FROM case_entries", [], |row| {
                row.get(0)
            })
            .optional()?
            .flatten();
        Ok(result.map(|v| v as u64))
    }

    /// Checks if the number of indexed entries matches the expected count.
    pub fn verify_count(&self, expected: u64) -> Result<bool, CaseIndexError> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM case_entries", [], |row| row.get(0))?;
        Ok(count as u64 == expected)
    }

    /// Verifies that a specific block's hash matches the stored hash.
    pub fn verify_hash(
        &self,
        block_index: u64,
        expected_hash: &str,
    ) -> Result<bool, CaseIndexError> {
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT block_hash FROM case_entries WHERE block_index = ?1",
                params![block_index as i64],
                |row| row.get(0),
            )
            .optional()?;
        Ok(stored.as_deref() == Some(expected_hash))
    }

    /// What the index holds — the health of the CACHE.
    ///
    /// MEASURED 2026-11-24 on the operator's host: the index held 1 372
    /// entries while the `cases` chain held 2 190 case blocks, and the
    /// index's `last_indexed_block` was 2 189 — the chain's LAST block.
    /// So the tail looked perfect while the first 818 entries were gone,
    /// and nothing could tell: the highest index says nothing about the
    /// lowest.
    ///
    /// The COUNT is the answer, and the count is what the caller compares
    /// with the chain's own count of case blocks. That is the only
    /// comparison that catches a gap at the HEAD.
    pub fn status(&self) -> Result<CaseIndexStatus, CaseIndexError> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM case_entries", [], |row| row.get(0))?;
        let last: Option<i64> = self
            .conn
            .query_row("SELECT MAX(block_index) FROM case_entries", [], |row| {
                row.get(0)
            })
            .optional()?
            .flatten();
        Ok(CaseIndexStatus {
            indexed: count as usize,
            last_indexed_block: last.map(|v| v as u64),
        })
    }
}

/// What the case index holds.
///
/// The count and the highest block index among the entries. A caller that
/// knows how many case blocks its chain holds can tell, with the count
/// alone, whether the index is in step with the chain — the highest index
/// cannot: a gap at the head leaves it untouched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseIndexStatus {
    /// How many entries the index holds.
    pub indexed: usize,
    /// The highest block index the index holds, or None when it holds none.
    pub last_indexed_block: Option<u64>,
}

fn extract_common_fields(
    entry: &CaseEntry,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    (
        entry.entity().map(String::from),
        entry.actor().map(String::from),
        entry.target().map(String::from),
        entry.instrument().map(String::from),
        entry.location().map(String::from),
        match entry {
            CaseEntry::Ablative { origin, .. } => Some(origin.clone()),
            _ => None,
        },
        match entry {
            CaseEntry::Ablative { destination, .. } => destination.clone(),
            _ => None,
        },
    )
}

fn extract_specific_fields(
    entry: &CaseEntry,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    match entry {
        CaseEntry::Genitive { owner, possessed } => (
            Some(owner.clone()),
            Some(possessed.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ),
        CaseEntry::Dative {
            giver,
            recipient,
            object,
        } => (
            None,
            None,
            Some(giver.clone()),
            Some(recipient.clone()),
            Some(object.clone()),
            None,
            None,
            None,
            None,
        ),
        CaseEntry::Accusative {
            subject,
            verb,
            object,
        } => (
            None,
            None,
            None,
            None,
            Some(object.clone()),
            Some(subject.clone()),
            Some(verb.clone()),
            None,
            None,
        ),
        CaseEntry::Vocative {
            invoker,
            invocation,
            ..
        } => (
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(invoker.clone()),
            Some(invocation.clone()),
        ),
        _ => (None, None, None, None, None, None, None, None, None),
    }
}

fn extract_timestamp(entry: &CaseEntry) -> Option<String> {
    match entry {
        CaseEntry::Nominative { timestamp, .. } => Some(timestamp.clone()),
        _ => None,
    }
}

#[derive(Debug)]
pub enum CaseIndexError {
    Sqlite(rusqlite::Error),
    Parse(String),
    Io(String),
}

impl std::fmt::Display for CaseIndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaseIndexError::Sqlite(e) => write!(f, "sqlite: {e}"),
            CaseIndexError::Parse(e) => write!(f, "parse: {e}"),
            CaseIndexError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for CaseIndexError {}

impl From<rusqlite::Error> for CaseIndexError {
    fn from(e: rusqlite::Error) -> Self {
        CaseIndexError::Sqlite(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use memphis_core::block::BlockData;
    use memphis_core::case_entry::CaseType;

    fn make_case_block(index: u64, entry: &CaseEntry) -> Block {
        Block {
            index,
            timestamp: "2026-03-22T10:00:00Z".into(),
            chain: "cases".into(),
            data: BlockData {
                block_type: BlockType::Case,
                content: entry.to_block_content().unwrap(),
                tags: vec![entry.tag()],
            },
            prev_hash: "0".repeat(64),
            hash: format!("{:064x}", index),
            signer: None,
            signature: None,
        }
    }

    fn make_journal_block(index: u64) -> Block {
        Block {
            index,
            timestamp: "2026-03-22T10:00:00Z".into(),
            chain: "journal".into(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "some journal entry".into(),
                tags: vec![],
            },
            prev_hash: "0".repeat(64),
            hash: format!("{:064x}", index),
            signer: None,
            signature: None,
        }
    }

    #[test]
    fn schema_init() {
        let idx = CaseIndex::open_in_memory().unwrap();
        assert!(idx.verify_count(0).unwrap());
        assert_eq!(idx.last_indexed_block().unwrap(), None);
    }

    #[test]
    fn index_and_query_single_entry() {
        let idx = CaseIndex::open_in_memory().unwrap();
        let entry = CaseEntry::Instrumental {
            actor: "Agent".into(),
            instrument: "memphis_exec".into(),
            target: "providers".into(),
        };
        let block = make_case_block(0, &entry);
        assert!(idx.index_block(&block).unwrap());
        assert!(idx.verify_count(1).unwrap());

        let results = idx.query(&CaseQuery::default()).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry, entry);
        assert_eq!(results[0].block_index, 0);
    }

    #[test]
    fn skips_non_case_blocks() {
        let idx = CaseIndex::open_in_memory().unwrap();
        let block = make_journal_block(0);
        assert!(!idx.index_block(&block).unwrap());
        assert!(idx.verify_count(0).unwrap());
    }

    #[test]
    fn query_by_case_type() {
        let idx = CaseIndex::open_in_memory().unwrap();
        idx.index_block(&make_case_block(
            0,
            &CaseEntry::Nominative {
                entity: "Agent".into(),
                action: "started".into(),
                timestamp: "2026-03-22T10:00:00Z".into(),
            },
        ))
        .unwrap();
        idx.index_block(&make_case_block(
            1,
            &CaseEntry::Instrumental {
                actor: "Agent".into(),
                instrument: "tool".into(),
                target: "file.rs".into(),
            },
        ))
        .unwrap();

        let q = CaseQuery {
            case_type: Some(CaseType::Instrumental),
            ..Default::default()
        };
        let results = idx.query(&q).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].case_type, "instrumental");
    }

    #[test]
    fn query_by_actor() {
        let idx = CaseIndex::open_in_memory().unwrap();
        idx.index_block(&make_case_block(
            0,
            &CaseEntry::Instrumental {
                actor: "Agent".into(),
                instrument: "tool".into(),
                target: "file.rs".into(),
            },
        ))
        .unwrap();
        idx.index_block(&make_case_block(
            1,
            &CaseEntry::Instrumental {
                actor: "User".into(),
                instrument: "tool".into(),
                target: "file2.rs".into(),
            },
        ))
        .unwrap();

        let q = CaseQuery {
            actor: Some("Agent".into()),
            ..Default::default()
        };
        let results = idx.query(&q).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].block_index, 0);
    }

    #[test]
    fn query_by_target() {
        let idx = CaseIndex::open_in_memory().unwrap();
        idx.index_block(&make_case_block(
            0,
            &CaseEntry::Vocative {
                invoker: "User".into(),
                invocation: "deploy".into(),
                target: "agent".into(),
            },
        ))
        .unwrap();
        idx.index_block(&make_case_block(
            1,
            &CaseEntry::Vocative {
                invoker: "User".into(),
                invocation: "status".into(),
                target: "system".into(),
            },
        ))
        .unwrap();

        let q = CaseQuery {
            target: Some("agent".into()),
            ..Default::default()
        };
        let results = idx.query(&q).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn query_with_limit() {
        let idx = CaseIndex::open_in_memory().unwrap();
        for i in 0..10 {
            idx.index_block(&make_case_block(
                i,
                &CaseEntry::Nominative {
                    entity: "Agent".into(),
                    action: format!("action_{i}"),
                    timestamp: "2026-03-22T10:00:00Z".into(),
                },
            ))
            .unwrap();
        }

        let q = CaseQuery {
            limit: Some(3),
            ..Default::default()
        };
        let results = idx.query(&q).unwrap();
        assert_eq!(results.len(), 3);
        // Most recent first (ORDER BY block_index DESC)
        assert_eq!(results[0].block_index, 9);
    }

    #[test]
    fn query_composite_case_type_and_actor() {
        let idx = CaseIndex::open_in_memory().unwrap();
        idx.index_block(&make_case_block(
            0,
            &CaseEntry::Instrumental {
                actor: "Agent".into(),
                instrument: "tool_a".into(),
                target: "file.rs".into(),
            },
        ))
        .unwrap();
        idx.index_block(&make_case_block(
            1,
            &CaseEntry::Instrumental {
                actor: "User".into(),
                instrument: "tool_b".into(),
                target: "file2.rs".into(),
            },
        ))
        .unwrap();
        idx.index_block(&make_case_block(
            2,
            &CaseEntry::Nominative {
                entity: "Agent".into(),
                action: "test".into(),
                timestamp: "2026-03-22T10:00:00Z".into(),
            },
        ))
        .unwrap();

        let q = CaseQuery {
            case_type: Some(CaseType::Instrumental),
            actor: Some("Agent".into()),
            ..Default::default()
        };
        let results = idx.query(&q).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].block_index, 0);
    }

    #[test]
    fn rebuild_from_blocks() {
        let idx = CaseIndex::open_in_memory().unwrap();
        let blocks = vec![
            make_journal_block(0),
            make_case_block(
                1,
                &CaseEntry::Nominative {
                    entity: "Agent".into(),
                    action: "started".into(),
                    timestamp: "2026-03-22T10:00:00Z".into(),
                },
            ),
            make_case_block(
                2,
                &CaseEntry::Instrumental {
                    actor: "Agent".into(),
                    instrument: "tool".into(),
                    target: "file.rs".into(),
                },
            ),
        ];

        let report = idx.rebuild(&blocks).unwrap();
        assert_eq!(report.indexed, 2);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.errors, 0);
        assert!(idx.verify_count(2).unwrap());
    }

    #[test]
    fn last_indexed_block_returns_max() {
        let idx = CaseIndex::open_in_memory().unwrap();
        assert_eq!(idx.last_indexed_block().unwrap(), None);

        idx.index_block(&make_case_block(
            5,
            &CaseEntry::Locative {
                entity: "Agent".into(),
                location: "session".into(),
            },
        ))
        .unwrap();
        idx.index_block(&make_case_block(
            10,
            &CaseEntry::Locative {
                entity: "Agent".into(),
                location: "session2".into(),
            },
        ))
        .unwrap();

        assert_eq!(idx.last_indexed_block().unwrap(), Some(10));
    }

    #[test]
    fn verify_hash_matches() {
        let idx = CaseIndex::open_in_memory().unwrap();
        let block = make_case_block(
            0,
            &CaseEntry::Genitive {
                owner: "User".into(),
                possessed: "API key".into(),
            },
        );
        idx.index_block(&block).unwrap();

        assert!(idx.verify_hash(0, &block.hash).unwrap());
        assert!(!idx.verify_hash(0, "wrong_hash").unwrap());
        assert!(!idx.verify_hash(999, &block.hash).unwrap());
    }

    #[test]
    fn all_eight_cases_index_correctly() {
        let idx = CaseIndex::open_in_memory().unwrap();
        let entries: Vec<CaseEntry> = vec![
            CaseEntry::Nominative {
                entity: "Agent".into(),
                action: "boot".into(),
                timestamp: "2026-03-22T10:00:00Z".into(),
            },
            CaseEntry::Genitive {
                owner: "User".into(),
                possessed: "vault".into(),
            },
            CaseEntry::Dative {
                giver: "Agent".into(),
                recipient: "Telegram".into(),
                object: "message".into(),
            },
            CaseEntry::Accusative {
                subject: "Agent".into(),
                verb: "modified".into(),
                object: "registry".into(),
            },
            CaseEntry::Instrumental {
                actor: "Agent".into(),
                instrument: "exec".into(),
                target: "file.rs".into(),
            },
            CaseEntry::Locative {
                entity: "Agent".into(),
                location: "session".into(),
            },
            CaseEntry::Ablative {
                entity: "Change".into(),
                origin: "snapshot".into(),
                destination: Some("branch".into()),
            },
            CaseEntry::Vocative {
                invoker: "User".into(),
                invocation: "deploy".into(),
                target: "agent".into(),
            },
        ];

        for (i, entry) in entries.iter().enumerate() {
            idx.index_block(&make_case_block(i as u64, entry)).unwrap();
        }

        assert!(idx.verify_count(8).unwrap());

        // Query each case type individually
        for ct in &[
            CaseType::Nominative,
            CaseType::Genitive,
            CaseType::Dative,
            CaseType::Accusative,
            CaseType::Instrumental,
            CaseType::Locative,
            CaseType::Ablative,
            CaseType::Vocative,
        ] {
            let q = CaseQuery {
                case_type: Some(*ct),
                ..Default::default()
            };
            let results = idx.query(&q).unwrap();
            assert_eq!(results.len(), 1, "expected 1 result for {ct:?}");
        }
    }

    #[test]
    fn open_creates_parent_directory() {
        let dir =
            std::env::temp_dir().join(format!("memphis-case-index-test-{}", std::process::id()));
        let db_path = dir.join("subdir").join("case-index.sqlite");

        // Ensure the directory doesn't exist
        let _ = std::fs::remove_dir_all(&dir);

        let idx = CaseIndex::open(&db_path).unwrap();
        assert!(idx.verify_count(0).unwrap());

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE COUNT SEES A GAP AT THE HEAD; THE HIGHEST INDEX DOES NOT.
    ///
    /// MEASURED 2026-11-24 on the operator's host: the index held 1 372
    /// entries where the chain holds 2 190 case blocks, and its highest
    /// block index was the chain's LAST one. So every signal that looks
    /// at the tail said "fine" while the first 818 entries were gone —
    /// including the host's only nominative entry and both instrumental
    /// ones.
    ///
    /// This is the falsifier for that blindness: index the TAIL of a
    /// chain, and the highest index will not tell the caller that the
    /// head is missing. The count will.
    #[test]
    fn the_status_tells_a_gap_at_the_head_that_the_last_index_cannot() {
        let dir =
            std::env::temp_dir().join(format!("memphis-case-index-head-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db_path = dir.join("case-index.sqlite");

        let idx = CaseIndex::open(&db_path).unwrap();

        // The chain holds EIGHT case blocks; the index is given the last
        // three of them — the state an index born mid-chain is in.
        let mut blocks = Vec::new();
        for index in 0..8u64 {
            blocks.push(make_case_block(
                index,
                &CaseEntry::Nominative {
                    entity: format!("entity-{index}"),
                    action: "acted".into(),
                    timestamp: "2026-03-22T10:00:00Z".into(),
                },
            ));
        }
        for block in blocks.iter().skip(5) {
            assert!(idx.index_block(block).unwrap());
        }

        let status = idx.status().unwrap();
        assert_eq!(status.indexed, 3, "the index holds three entries");
        assert_eq!(
            status.last_indexed_block,
            Some(7),
            "the highest index is the chain's LAST block — it cannot see the gap"
        );

        // The chain holds eight case blocks and the index holds three:
        // THE COUNT IS THE SIGNAL. A caller that compares the two sees
        // the drift; a caller that compares the highest index sees none.
        let chain_case_blocks = blocks.len();
        assert_ne!(
            status.indexed, chain_case_blocks,
            "the count must differ from the chain's, or the drift is invisible"
        );

        // And the repair makes them equal — so the check cannot loop.
        let report = idx.rebuild(&blocks).unwrap();
        assert_eq!(report.indexed, 8);
        let status = idx.status().unwrap();
        assert_eq!(status.indexed, chain_case_blocks);
        assert_eq!(status.last_indexed_block, Some(7));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An empty index answers zero and no highest block — and says so
    /// with a NULL, not with an absent key.
    #[test]
    fn an_empty_index_answers_zero_and_no_block() {
        let dir =
            std::env::temp_dir().join(format!("memphis-case-index-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db_path = dir.join("case-index.sqlite");

        let idx = CaseIndex::open(&db_path).unwrap();
        let status = idx.status().unwrap();
        assert_eq!(status.indexed, 0);
        assert_eq!(status.last_indexed_block, None);

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["indexed"], 0);
        assert!(
            json["lastIndexedBlock"].is_null(),
            "the highest block is PRESENT and null, not absent: {:?}",
            json
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
