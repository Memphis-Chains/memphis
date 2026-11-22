//! The marker that says "this chain continues from an archived prefix".
//!
//! ## Why this exists
//!
//! Chain rotation archives the old blocks of a chain and keeps the tail
//! live. That is the mechanism that stops the `system` chain from growing
//! without bound — 15 748 blocks / 62 MB on the operator's host, growing
//! by 100-280 blocks a day.
//!
//! But the rotated chain did not verify. Measured 2026-11-22: rotating a
//! COPY of the live `system` chain with the repo's own `rotateChain`
//! produced this on the very next command:
//!
//! ```text
//! [INTERNAL_ERROR] chain 'system' integrity check failed at block 15739
//! (015739.json): missing genesis block (chain must start at index 0 or 1)
//! ```
//!
//! The validators require the first live block to be the genesis block,
//! because that is what makes the chain's history provable. Rotation
//! breaks that link — the first live block links to a block that is no
//! longer in the directory.
//!
//! That is why rotation was never enabled. The feature produced a chain
//! the runtime itself rejected.
//!
//! ## The rule
//!
//! The live chain does not have to start at genesis. It has to start at a
//! point whose link to the archive can be PROVEN. The marker carries that
//! proof: the index and the hash of the last archived block. The first
//! live block must be exactly one index after it, and its `prev_hash`
//! must be exactly that hash. A marker that does not match is rejected,
//! so a truncated or spliced chain still fails.
//!
//! ## One format, two arms
//!
//! The TypeScript validator (`src/infra/storage/chain-adapter.ts`) and
//! this one must agree, so the shape is a contract fixture both arms
//! read: `tests/fixtures/chain-rotation-head-contract.json`.
//!
//! The file name deliberately does NOT end in `.json`: a chain directory
//! is read as a list of `.json` blocks by at least six places in this
//! repository, and a marker named `*.json` would be parsed as a block.

use std::path::Path;

use serde_json::Value;

/// The marker's format tag.
pub const ROTATION_HEAD_FORMAT: &str = "memphis-chain-rotation-head.v1";

/// The marker's file name inside a chain directory.
pub const ROTATION_HEAD_FILENAME: &str = "chain-rotation.head";

/// A chain that continues an archived prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainRotationHead {
    pub chain: String,
    pub archived_from: i64,
    pub archived_to: i64,
    pub last_archived_index: i64,
    pub last_archived_hash: String,
    pub archive_path: String,
    pub rotated_at: String,
}

/// Is this hash a SHA-256 hex digest?
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Parse a marker out of raw file content.
///
/// A parse failure means "no usable marker", which makes the validator
/// fall back to the genesis rule — fail closed, never fail open.
pub fn parse_chain_rotation_head(raw: &str) -> Option<ChainRotationHead> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    if object.get("format").and_then(Value::as_str) != Some(ROTATION_HEAD_FORMAT) {
        return None;
    }
    let chain = object.get("chain").and_then(Value::as_str)?.to_string();
    if chain.is_empty() {
        return None;
    }
    let archived_from = object.get("archivedFrom").and_then(Value::as_i64)?;
    let archived_to = object.get("archivedTo").and_then(Value::as_i64)?;
    let last_archived_index = object.get("lastArchivedIndex").and_then(Value::as_i64)?;
    let last_archived_hash = object.get("lastArchivedHash").and_then(Value::as_str)?.to_string();
    if !is_sha256_hex(&last_archived_hash) {
        return None;
    }
    let archive_path = object.get("archivePath").and_then(Value::as_str)?.to_string();
    let rotated_at = object.get("rotatedAt").and_then(Value::as_str)?.to_string();
    Some(ChainRotationHead {
        chain,
        archived_from,
        archived_to,
        last_archived_index,
        last_archived_hash,
        archive_path,
        rotated_at,
    })
}

/// Read the marker from a chain directory.
///
/// A missing marker is not an error: a chain that has never been rotated
/// has none, and the validators apply the genesis rule to it.
pub fn read_chain_rotation_head(chain_dir: &Path) -> Option<ChainRotationHead> {
    let raw = std::fs::read_to_string(chain_dir.join(ROTATION_HEAD_FILENAME)).ok()?;
    parse_chain_rotation_head(&raw)
}

/// Does the first live block continue the archived prefix?
///
/// The whole point of the marker: the chain's history is provable even
/// though the prefix lives in an archive.
pub fn continues_archived_prefix(
    head: &ChainRotationHead,
    first_live_index: i64,
    first_live_prev_hash: &str,
) -> bool {
    head.last_archived_index + 1 == first_live_index && head.last_archived_hash == first_live_prev_hash
}

/// The `prev_hash` a genesis block carries.
pub const GENESIS_PREV_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// May a chain start here?
///
/// Two ways to be right, and no third:
///
/// 1. The chain starts at genesis — index 0 with the genesis hash, or
///    index 1 with an empty or genesis `prev_hash`. This is what a chain
///    that was never rotated looks like.
/// 2. The chain CONTINUES an archived prefix, and the marker proves it:
///    the first live block is exactly one index after the archived head
///    and links to it.
///
/// Everything else is a broken chain. A marker that does not match is not
/// a licence: a truncated or spliced chain still fails.
pub fn is_valid_chain_start(
    head: Option<&ChainRotationHead>,
    first_live_index: i64,
    first_live_prev_hash: &str,
) -> bool {
    if let Some(head) = head {
        if continues_archived_prefix(head, first_live_index, first_live_prev_hash) {
            return true;
        }
    }
    if first_live_index == 0 {
        return first_live_prev_hash == GENESIS_PREV_HASH;
    }
    if first_live_index == 1 {
        return first_live_prev_hash.is_empty() || first_live_prev_hash == GENESIS_PREV_HASH;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head_json(last_hash: &str) -> String {
        format!(
            r#"{{"format":"{ROTATION_HEAD_FORMAT}","chain":"system","archivedFrom":1,"archivedTo":15738,"lastArchivedIndex":15738,"lastArchivedHash":"{last_hash}","archivePath":"/tmp/a.jsonl.gz","rotatedAt":"2026-11-22T13:40:56.914Z"}}"#
        )
    }

    #[test]
    fn parses_a_well_formed_head() {
        let hash = "a".repeat(64);
        let head = parse_chain_rotation_head(&head_json(&hash)).expect("head");
        assert_eq!(head.last_archived_index, 15738);
        assert_eq!(head.last_archived_hash, hash);
    }

    #[test]
    fn rejects_a_head_with_a_bad_hash_shape() {
        assert!(parse_chain_rotation_head(&head_json("not-a-hash")).is_none());
    }

    #[test]
    fn rejects_a_head_with_the_wrong_format() {
        let raw = head_json(&"a".repeat(64)).replace(ROTATION_HEAD_FORMAT, "something-else");
        assert!(parse_chain_rotation_head(&raw).is_none());
    }

    #[test]
    fn a_live_block_must_follow_the_archived_head_exactly() {
        let hash = "b".repeat(64);
        let head = parse_chain_rotation_head(&head_json(&hash)).expect("head");
        assert!(continues_archived_prefix(&head, 15739, &hash));
        // A skipped index is not a continuation.
        assert!(!continues_archived_prefix(&head, 15741, &hash));
        // A mismatched link is not a continuation.
        assert!(!continues_archived_prefix(&head, 15739, &"c".repeat(64)));
    }
}
