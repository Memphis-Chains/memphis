use serde::{Deserialize, Serialize};

use crate::block::{Block, BlockType};

/// The eight Polish grammatical cases as semantic chain entry types.
///
/// Each case defines a fundamental relation between entities in the agent's
/// cognitive knowledge graph:
///
/// | Case         | Polish Name  | Question          | Role                  |
/// |--------------|--------------|-------------------|-----------------------|
/// | Nominative   | Mianownik    | kto? co?          | Subject / Agent       |
/// | Genitive     | Rodzicielnik | kogo? czyj?       | Possession / Relation |
/// | Dative       | Dajnik       | komu? czemu?      | Recipient             |
/// | Accusative   | Biernik      | kogo? co?         | Direct Object         |
/// | Instrumental | Narzędnik    | kim? czym?        | Means / Tool          |
/// | Locative     | Miejscownik  | w kim? w czym?    | Location / Context    |
/// | Ablative     | Odchodnik    | od kogo? czego?   | Origin / Departure    |
/// | Vocative     | Wołajnik     | o!                | Invocation / Call     |
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "case_type", rename_all = "snake_case")]
pub enum CaseEntry {
    /// Who? What? — the subject of an action.
    Nominative {
        entity: String,
        action: String,
        timestamp: String,
    },
    /// Whose? — possession, belonging, or relation.
    Genitive { owner: String, possessed: String },
    /// To whom? To what? — the recipient.
    Dative {
        giver: String,
        recipient: String,
        object: String,
    },
    /// Whom? What? — the direct object acted upon.
    Accusative {
        subject: String,
        verb: String,
        object: String,
    },
    /// With what? — the instrument or means.
    Instrumental {
        actor: String,
        instrument: String,
        target: String,
    },
    /// Where? In what context? — location or session.
    Locative { entity: String, location: String },
    /// From where? — origin or separation.
    Ablative {
        entity: String,
        origin: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<String>,
    },
    /// Direct call or invocation.
    Vocative {
        invoker: String,
        invocation: String,
        target: String,
    },
}

/// Unit enum for case type filtering in queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaseType {
    Nominative,
    Genitive,
    Dative,
    Accusative,
    Instrumental,
    Locative,
    Ablative,
    Vocative,
}

impl CaseType {
    pub fn as_str(&self) -> &'static str {
        match self {
            CaseType::Nominative => "nominative",
            CaseType::Genitive => "genitive",
            CaseType::Dative => "dative",
            CaseType::Accusative => "accusative",
            CaseType::Instrumental => "instrumental",
            CaseType::Locative => "locative",
            CaseType::Ablative => "ablative",
            CaseType::Vocative => "vocative",
        }
    }

    pub fn tag(&self) -> String {
        format!("case:{}", self.as_str())
    }
}

impl CaseEntry {
    /// Returns the case type of this entry.
    pub fn case_type(&self) -> CaseType {
        match self {
            CaseEntry::Nominative { .. } => CaseType::Nominative,
            CaseEntry::Genitive { .. } => CaseType::Genitive,
            CaseEntry::Dative { .. } => CaseType::Dative,
            CaseEntry::Accusative { .. } => CaseType::Accusative,
            CaseEntry::Instrumental { .. } => CaseType::Instrumental,
            CaseEntry::Locative { .. } => CaseType::Locative,
            CaseEntry::Ablative { .. } => CaseType::Ablative,
            CaseEntry::Vocative { .. } => CaseType::Vocative,
        }
    }

    /// Serializes this entry to JSON for storage in a Block's content field.
    pub fn to_block_content(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserializes a CaseEntry from a Block's content field.
    pub fn from_block_content(s: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(s)
    }

    /// Returns the tag string for this entry (e.g., "case:nominative").
    pub fn tag(&self) -> String {
        self.case_type().tag()
    }

    /// Validates that all required string fields are non-empty (after trimming).
    /// Returns an error message if validation fails.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            CaseEntry::Nominative {
                entity,
                action,
                timestamp,
            } => {
                check_non_empty("entity", entity)?;
                check_non_empty("action", action)?;
                check_non_empty("timestamp", timestamp)?;
                check_rfc3339("timestamp", timestamp)?;
            }
            CaseEntry::Genitive { owner, possessed } => {
                check_non_empty("owner", owner)?;
                check_non_empty("possessed", possessed)?;
            }
            CaseEntry::Dative {
                giver,
                recipient,
                object,
            } => {
                check_non_empty("giver", giver)?;
                check_non_empty("recipient", recipient)?;
                check_non_empty("object", object)?;
            }
            CaseEntry::Accusative {
                subject,
                verb,
                object,
            } => {
                check_non_empty("subject", subject)?;
                check_non_empty("verb", verb)?;
                check_non_empty("object", object)?;
            }
            CaseEntry::Instrumental {
                actor,
                instrument,
                target,
            } => {
                check_non_empty("actor", actor)?;
                check_non_empty("instrument", instrument)?;
                check_non_empty("target", target)?;
            }
            CaseEntry::Locative { entity, location } => {
                check_non_empty("entity", entity)?;
                check_non_empty("location", location)?;
            }
            CaseEntry::Ablative {
                entity,
                origin,
                destination,
            } => {
                check_non_empty("entity", entity)?;
                check_non_empty("origin", origin)?;
                if let Some(dest) = destination {
                    check_non_empty("destination", dest)?;
                }
            }
            CaseEntry::Vocative {
                invoker,
                invocation,
                target,
            } => {
                check_non_empty("invoker", invoker)?;
                check_non_empty("invocation", invocation)?;
                check_non_empty("target", target)?;
            }
        }
        Ok(())
    }

    /// Extracts the entity field if present (Nominative, Locative, Ablative).
    pub fn entity(&self) -> Option<&str> {
        match self {
            CaseEntry::Nominative { entity, .. }
            | CaseEntry::Locative { entity, .. }
            | CaseEntry::Ablative { entity, .. } => Some(entity),
            _ => None,
        }
    }

    /// Extracts the actor field if present (Instrumental).
    pub fn actor(&self) -> Option<&str> {
        match self {
            CaseEntry::Instrumental { actor, .. } => Some(actor),
            _ => None,
        }
    }

    /// Extracts the target field if present (Instrumental, Vocative).
    pub fn target(&self) -> Option<&str> {
        match self {
            CaseEntry::Instrumental { target, .. } | CaseEntry::Vocative { target, .. } => {
                Some(target)
            }
            _ => None,
        }
    }

    /// Extracts the instrument field if present (Instrumental).
    pub fn instrument(&self) -> Option<&str> {
        match self {
            CaseEntry::Instrumental { instrument, .. } => Some(instrument),
            _ => None,
        }
    }

    /// Extracts the location field if present (Locative).
    pub fn location(&self) -> Option<&str> {
        match self {
            CaseEntry::Locative { location, .. } => Some(location),
            _ => None,
        }
    }
}

fn check_non_empty(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must not be empty"))
    } else {
        Ok(())
    }
}

fn check_rfc3339(field: &str, value: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|e| format!("{field} must be RFC3339: {e}"))
}

/// Query parameters for filtering case entries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaseQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_type: Option<CaseType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instrument: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// In-memory filter for case entries when SQLite index is unavailable.
/// Only scans blocks with `BlockType::Case`.
pub fn case_query_blocks<'a>(blocks: &'a [Block], query: &CaseQuery) -> Vec<&'a Block> {
    let mut results: Vec<&Block> = blocks
        .iter()
        .rev() // most recent first
        .filter(|b| matches!(b.data.block_type, BlockType::Case))
        .filter(|b| {
            let entry = match CaseEntry::from_block_content(&b.data.content) {
                Ok(e) => e,
                Err(_) => return false,
            };
            matches_query(&entry, query)
        })
        .collect();

    if let Some(limit) = query.limit {
        results.truncate(limit);
    }

    results
}

fn matches_query(entry: &CaseEntry, query: &CaseQuery) -> bool {
    if let Some(ref ct) = query.case_type {
        if entry.case_type() != *ct {
            return false;
        }
    }
    if let Some(ref entity) = query.entity {
        match entry.entity() {
            Some(e) if e == entity => {}
            Some(_) => return false,
            None => return false,
        }
    }
    if let Some(ref actor) = query.actor {
        match entry.actor() {
            Some(a) if a == actor => {}
            Some(_) => return false,
            None => return false,
        }
    }
    if let Some(ref target) = query.target {
        match entry.target() {
            Some(t) if t == target => {}
            Some(_) => return false,
            None => return false,
        }
    }
    if let Some(ref instrument) = query.instrument {
        match entry.instrument() {
            Some(i) if i == instrument => {}
            Some(_) => return false,
            None => return false,
        }
    }
    if let Some(ref location) = query.location {
        match entry.location() {
            Some(l) if l == location => {}
            Some(_) => return false,
            None => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip_nominative() {
        let entry = CaseEntry::Nominative {
            entity: "Agent".into(),
            action: "initiated".into(),
            timestamp: "2026-03-22T10:00:00Z".into(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let parsed: CaseEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(entry, parsed);
        assert!(json.contains("\"case_type\":\"nominative\""));
    }

    #[test]
    fn serde_roundtrip_genitive() {
        let entry = CaseEntry::Genitive {
            owner: "User".into(),
            possessed: "API key".into(),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_dative() {
        let entry = CaseEntry::Dative {
            giver: "Agent".into(),
            recipient: "Telegram".into(),
            object: "message".into(),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_accusative() {
        let entry = CaseEntry::Accusative {
            subject: "Agent".into(),
            verb: "modified".into(),
            object: "tool registry".into(),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_instrumental() {
        let entry = CaseEntry::Instrumental {
            actor: "Agent".into(),
            instrument: "memphis_self_modify".into(),
            target: "src/providers/synjar.ts".into(),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_locative() {
        let entry = CaseEntry::Locative {
            entity: "Agent".into(),
            location: "evolve session #123".into(),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_ablative() {
        let entry = CaseEntry::Ablative {
            entity: "Change".into(),
            origin: "snapshot abc123".into(),
            destination: Some("branch evolve/synjar".into()),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_ablative_no_destination() {
        let entry = CaseEntry::Ablative {
            entity: "Change".into(),
            origin: "snapshot abc123".into(),
            destination: None,
        };
        let json = entry.to_block_content().unwrap();
        assert!(!json.contains("destination"));
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn serde_roundtrip_vocative() {
        let entry = CaseEntry::Vocative {
            invoker: "User".into(),
            invocation: "memphis deploy".into(),
            target: "agent".into(),
        };
        let json = entry.to_block_content().unwrap();
        let parsed = CaseEntry::from_block_content(&json).unwrap();
        assert_eq!(entry, parsed);
    }

    #[test]
    fn validate_rejects_empty_fields() {
        let entry = CaseEntry::Nominative {
            entity: "".into(),
            action: "test".into(),
            timestamp: "2026-03-22T10:00:00Z".into(),
        };
        assert!(entry.validate().is_err());
        assert!(entry.validate().unwrap_err().contains("entity"));
    }

    #[test]
    fn validate_rejects_whitespace_only() {
        let entry = CaseEntry::Instrumental {
            actor: "  ".into(),
            instrument: "tool".into(),
            target: "file.rs".into(),
        };
        assert!(entry.validate().is_err());
    }

    #[test]
    fn validate_rejects_bad_timestamp() {
        let entry = CaseEntry::Nominative {
            entity: "Agent".into(),
            action: "test".into(),
            timestamp: "not-a-date".into(),
        };
        assert!(entry.validate().is_err());
        assert!(entry.validate().unwrap_err().contains("RFC3339"));
    }

    #[test]
    fn validate_accepts_valid_entries() {
        let entry = CaseEntry::Nominative {
            entity: "Agent".into(),
            action: "test".into(),
            timestamp: "2026-03-22T10:00:00Z".into(),
        };
        assert!(entry.validate().is_ok());

        let entry = CaseEntry::Genitive {
            owner: "User".into(),
            possessed: "key".into(),
        };
        assert!(entry.validate().is_ok());
    }

    #[test]
    fn case_type_accessor() {
        let entry = CaseEntry::Instrumental {
            actor: "Agent".into(),
            instrument: "tool".into(),
            target: "file".into(),
        };
        assert_eq!(entry.case_type(), CaseType::Instrumental);
        assert_eq!(entry.tag(), "case:instrumental");
    }

    #[test]
    fn field_accessors() {
        let entry = CaseEntry::Instrumental {
            actor: "Agent".into(),
            instrument: "memphis_exec".into(),
            target: "providers".into(),
        };
        assert_eq!(entry.actor(), Some("Agent"));
        assert_eq!(entry.instrument(), Some("memphis_exec"));
        assert_eq!(entry.target(), Some("providers"));
        assert_eq!(entry.entity(), None);
        assert_eq!(entry.location(), None);
    }

    #[test]
    fn case_query_blocks_filters_by_type() {
        let blocks = vec![
            make_case_block(
                0,
                &CaseEntry::Nominative {
                    entity: "Agent".into(),
                    action: "started".into(),
                    timestamp: "2026-03-22T10:00:00Z".into(),
                },
            ),
            make_case_block(
                1,
                &CaseEntry::Instrumental {
                    actor: "Agent".into(),
                    instrument: "tool".into(),
                    target: "file.rs".into(),
                },
            ),
            make_case_block(
                2,
                &CaseEntry::Instrumental {
                    actor: "Agent".into(),
                    instrument: "other".into(),
                    target: "file2.rs".into(),
                },
            ),
        ];

        let query = CaseQuery {
            case_type: Some(CaseType::Instrumental),
            ..Default::default()
        };
        let results = case_query_blocks(&blocks, &query);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn case_query_blocks_filters_by_actor() {
        let blocks = vec![
            make_case_block(
                0,
                &CaseEntry::Instrumental {
                    actor: "Agent".into(),
                    instrument: "tool".into(),
                    target: "file.rs".into(),
                },
            ),
            make_case_block(
                1,
                &CaseEntry::Instrumental {
                    actor: "User".into(),
                    instrument: "tool".into(),
                    target: "file2.rs".into(),
                },
            ),
        ];

        let query = CaseQuery {
            actor: Some("Agent".into()),
            ..Default::default()
        };
        let results = case_query_blocks(&blocks, &query);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn case_query_blocks_respects_limit() {
        let blocks: Vec<Block> = (0..10)
            .map(|i| {
                make_case_block(
                    i,
                    &CaseEntry::Nominative {
                        entity: "Agent".into(),
                        action: format!("action_{i}"),
                        timestamp: "2026-03-22T10:00:00Z".into(),
                    },
                )
            })
            .collect();

        let query = CaseQuery {
            limit: Some(3),
            ..Default::default()
        };
        let results = case_query_blocks(&blocks, &query);
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn case_query_blocks_skips_non_case_blocks() {
        use crate::block::{BlockData, BlockType};
        let blocks = vec![
            Block {
                index: 0,
                timestamp: "2026-03-22T10:00:00Z".into(),
                chain: "journal".into(),
                data: BlockData {
                    block_type: BlockType::Journal,
                    content: "some journal entry".into(),
                    tags: vec![],
                },
                prev_hash: "0".repeat(64),
                hash: "a".repeat(64),
                signer: None,
                signature: None,
            },
            make_case_block(
                1,
                &CaseEntry::Nominative {
                    entity: "Agent".into(),
                    action: "test".into(),
                    timestamp: "2026-03-22T10:00:00Z".into(),
                },
            ),
        ];

        let query = CaseQuery::default();
        let results = case_query_blocks(&blocks, &query);
        assert_eq!(results.len(), 1);
    }

    fn make_case_block(index: u64, entry: &CaseEntry) -> Block {
        use crate::block::BlockData;
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
            hash: "a".repeat(64),
            signer: None,
            signature: None,
        }
    }
}
