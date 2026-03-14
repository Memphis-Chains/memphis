use crate::block::Block;
use crate::chain::MemoryChain;
use crate::hash::compute_hash;
use crate::soul::validate_block;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplaySnapshot {
    pub blocks: usize,
    pub last_hash: Option<String>,
    pub state_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayReport {
    pub accepted: usize,
    pub rejected: usize,
    pub errors: Vec<String>,
    pub snapshot: ReplaySnapshot,
}

pub fn replay(chain_name: impl Into<String>, blocks: &[Block]) -> ReplayReport {
    let mut chain = MemoryChain::new(chain_name);
    let mut accepted = 0usize;
    let mut rejected = 0usize;
    let mut errors: Vec<String> = vec![];

    for block in blocks {
        match validate_block(block, chain.blocks.last()) {
            Ok(()) => {
                chain.blocks.push(block.clone());
                accepted += 1;
            }
            Err(errs) => {
                rejected += 1;
                errors.push(format!("block_index_{}: {}", block.index, errs.join("; ")));
            }
        }
    }

    ReplayReport {
        accepted,
        rejected,
        errors,
        snapshot: snapshot(&chain),
    }
}

pub fn snapshot(chain: &MemoryChain) -> ReplaySnapshot {
    let mut hasher = Sha256::new();
    for block in &chain.blocks {
        let h = if block.hash.trim().is_empty() {
            compute_hash(block)
        } else {
            block.hash.clone()
        };
        hasher.update(h.as_bytes());
    }
    let state_hash = format!("{:x}", hasher.finalize());

    ReplaySnapshot {
        blocks: chain.blocks.len(),
        last_hash: chain.blocks.last().map(|b| {
            if b.hash.trim().is_empty() {
                compute_hash(b)
            } else {
                b.hash.clone()
            }
        }),
        state_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::{replay, snapshot};
    use crate::block::{Block, BlockData, BlockType};
    use crate::chain::MemoryChain;
    use crate::hash::compute_hash;

    fn mk_block(index: u64, prev_hash: String, ts: &str, content: &str) -> Block {
        let mut block = Block {
            index,
            timestamp: ts.to_string(),
            chain: "system".to_string(),
            data: BlockData {
                block_type: BlockType::SystemEvent,
                content: content.to_string(),
                tags: vec!["replay".to_string()],
            },
            prev_hash,
            hash: String::new(),
            signer: None,
            signature: None,
        };
        block.hash = compute_hash(&block);
        block
    }

    #[test]
    fn replay_is_deterministic_for_same_input() {
        let b0 = mk_block(0, "0".repeat(64), "2026-03-12T12:00:00Z", "boot");
        let b1 = mk_block(1, b0.hash.clone(), "2026-03-12T12:00:01Z", "queue_resume");
        let blocks = vec![b0.clone(), b1.clone()];

        let first = replay("system", &blocks);
        let second = replay("system", &blocks);
        assert_eq!(first.snapshot, second.snapshot);
        assert_eq!(first.accepted, 2);
        assert_eq!(first.rejected, 0);
    }

    #[test]
    fn replay_rejects_invalid_block_and_continues() {
        let b0 = mk_block(0, "0".repeat(64), "2026-03-12T12:00:00Z", "boot");
        let mut bad = mk_block(2, "wrong".to_string(), "2026-03-12T12:00:01Z", "bad");
        bad.prev_hash = "mismatch".to_string();

        let report = replay("system", &[b0, bad]);
        assert_eq!(report.accepted, 1);
        assert_eq!(report.rejected, 1);
        assert!(!report.errors.is_empty());
    }

    #[test]
    fn snapshot_uses_computed_hash_when_missing() {
        let mut chain = MemoryChain::new("system");
        let mut b0 = mk_block(0, "0".repeat(64), "2026-03-12T12:00:00Z", "boot");
        b0.hash.clear();
        chain.blocks.push(b0);
        let snap = snapshot(&chain);
        assert_eq!(snap.blocks, 1);
        assert!(snap.last_hash.is_some());
        assert!(!snap.state_hash.is_empty());
    }
}
