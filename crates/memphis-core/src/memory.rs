use crate::block::{Block, BlockData, BlockType};
use crate::chain::MemoryChain;
use crate::hash::compute_hash;

pub struct MemoryStore {
    pub chain: MemoryChain,
}

impl MemoryStore {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            chain: MemoryChain::new(name),
        }
    }

    pub fn append_entry(
        &mut self,
        block_type: BlockType,
        content: impl Into<String>,
        tags: Vec<String>,
        timestamp: impl Into<String>,
    ) -> Result<Block, Vec<String>> {
        let index = self.chain.len() as u64;
        let prev_hash = self
            .chain
            .blocks
            .last()
            .map(|b| b.hash.clone())
            .unwrap_or_else(|| "0".repeat(64));

        let mut block = Block {
            index,
            timestamp: timestamp.into(),
            chain: self.chain.name.clone(),
            data: BlockData {
                block_type,
                content: content.into(),
                tags,
            },
            prev_hash,
            hash: String::new(),
            signer: None,
            signature: None,
        };
        block.hash = compute_hash(&block);
        self.chain.append(block.clone())?;
        Ok(block)
    }

    pub fn recall_by_keyword(&self, keyword: &str, limit: usize) -> Vec<&Block> {
        let needle = keyword.to_lowercase();
        self.chain
            .blocks
            .iter()
            .rev()
            .filter(|block| block.data.content.to_lowercase().contains(&needle))
            .take(limit)
            .collect()
    }

    pub fn recall_by_tag(&self, tag: &str, limit: usize) -> Vec<&Block> {
        let needle = tag.to_lowercase();
        self.chain
            .blocks
            .iter()
            .rev()
            .filter(|block| block.data.tags.iter().any(|t| t.to_lowercase() == needle))
            .take(limit)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::MemoryStore;
    use crate::block::BlockType;

    #[test]
    fn append_and_recall_by_keyword_and_tag() {
        let mut store = MemoryStore::new("system");
        store
            .append_entry(
                BlockType::SystemEvent,
                "queue resumed",
                vec!["queue".to_string(), "startup".to_string()],
                "2026-03-12T12:00:00Z",
            )
            .expect("append queue event");
        store
            .append_entry(
                BlockType::ToolResult,
                "tool output ready",
                vec!["tool".to_string()],
                "2026-03-12T12:00:01Z",
            )
            .expect("append tool event");

        let by_keyword = store.recall_by_keyword("queue", 5);
        assert_eq!(by_keyword.len(), 1);
        assert_eq!(by_keyword[0].data.content, "queue resumed");

        let by_tag = store.recall_by_tag("tool", 5);
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].data.content, "tool output ready");
    }
}
