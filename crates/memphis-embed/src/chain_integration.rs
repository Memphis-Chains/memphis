use crate::{ChainRef, EmbedError, VectorEntry, VectorStore};
use memphis_core::chain::MemoryChain;
use std::collections::HashMap;

pub struct ChainAwareEmbedStore {
    vector_store: VectorStore,
}

impl ChainAwareEmbedStore {
    pub fn new(vector_store: VectorStore) -> Self {
        Self { vector_store }
    }

    pub fn store_from_chain(
        &mut self,
        chain: &MemoryChain,
        block_index: u64,
        vector: Vec<f32>,
        metadata: HashMap<String, String>,
    ) -> Result<String, EmbedError> {
        let block = chain
            .blocks
            .iter()
            .find(|b| b.index == block_index)
            .ok_or_else(|| EmbedError::NotFound(format!("Block {block_index} not found")))?;

        let chain_ref = ChainRef {
            chain: chain.name.clone(),
            index: block_index,
            hash: block.hash.clone(),
        };

        let id = format!("{}:{}", chain.name, block_index);

        let entry = VectorEntry {
            id: id.clone(),
            vector,
            metadata,
            created_at: chrono::Utc::now().timestamp(),
            chain_ref: Some(chain_ref),
        };

        self.vector_store.upsert_entry(entry)?;
        Ok(id)
    }

    pub fn search_with_context(
        &self,
        query: &[f32],
        top_k: usize,
        chain: Option<&MemoryChain>,
    ) -> Result<Vec<(f32, VectorEntry, Option<String>)>, EmbedError> {
        let results = self.vector_store.search(query, top_k)?;

        let enriched = results
            .into_iter()
            .map(|(score, entry)| {
                let content = entry.chain_ref.as_ref().and_then(|chain_ref| {
                    chain.and_then(|c| {
                        if c.name == chain_ref.chain {
                            c.blocks
                                .iter()
                                .find(|b| b.index == chain_ref.index)
                                .map(|b| b.data.content.clone())
                        } else {
                            None
                        }
                    })
                });

                (score, entry, content)
            })
            .collect();

        Ok(enriched)
    }

    pub fn inner(&self) -> &VectorStore {
        &self.vector_store
    }
}
