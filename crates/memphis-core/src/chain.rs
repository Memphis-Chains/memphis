use crate::block::{Block, BlockData};
use crate::soul::{validate_block, validate_block_strict};

pub struct MemoryChain {
    pub name: String,
    pub blocks: Vec<Block>,
}

impl MemoryChain {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            blocks: vec![],
        }
    }

    pub fn append(&mut self, block: Block) -> Result<(), Vec<String>> {
        let prev = self.blocks.last();
        validate_block(&block, prev)?;
        self.blocks.push(block);
        Ok(())
    }

    pub fn append_strict(&mut self, block: Block) -> Result<(), Vec<String>> {
        let prev = self.blocks.last();
        validate_block_strict(&block, prev)?;
        self.blocks.push(block);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.blocks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    pub fn tail(&self, n: usize) -> Vec<&Block> {
        self.blocks.iter().rev().take(n).collect()
    }

    #[allow(dead_code)]
    pub fn append_data_placeholder(&mut self, _data: BlockData) {
        // reserved for next slice
    }
}

#[cfg(test)]
mod tests {
    use super::MemoryChain;
    use crate::block::{Block, BlockData, BlockType};
    use crate::hash::compute_hash;
    use crate::signature::sign_block;

    fn mk_block(index: u64, prev_hash: String, ts: &str) -> Block {
        let mut block = Block {
            index,
            timestamp: ts.to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "ok".to_string(),
                tags: vec![],
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
    fn append_valid_genesis_and_next_block() {
        let mut chain = MemoryChain::new("journal");
        let b0 = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        let b1 = mk_block(1, b0.hash.clone(), "2026-03-08T21:00:01Z");

        assert!(chain.append(b0).is_ok());
        assert!(chain.append(b1).is_ok());
        assert_eq!(chain.len(), 2);
    }

    #[test]
    fn append_strict_rejects_unsigned_block() {
        let mut chain = MemoryChain::new("journal");
        let b0 = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        assert!(chain.append_strict(b0).is_err());
    }

    #[test]
    fn append_strict_accepts_signed_block() {
        let mut chain = MemoryChain::new("journal");
        let mut b0 = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        sign_block(&mut b0, &[17u8; 32]).expect("signing should succeed");
        assert!(chain.append_strict(b0).is_ok());
    }
}
