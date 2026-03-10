use crate::error::EmbedError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::create_dir_all;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorEntry {
    pub id: String,
    pub vector: Vec<f32>,
    pub metadata: HashMap<String, String>,
    pub created_at: i64,
    pub chain_ref: Option<ChainRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainRef {
    pub chain: String,
    pub index: u64,
    pub hash: String,
}

pub struct VectorStore {
    vectors: HashMap<String, VectorEntry>,
    index_path: Option<PathBuf>,
    enable_disk: bool,
}

impl Default for VectorStore {
    fn default() -> Self {
        Self::new()
    }
}

impl VectorStore {
    pub fn new() -> Self {
        Self {
            vectors: HashMap::new(),
            index_path: None,
            enable_disk: false,
        }
    }

    pub fn with_disk(base_path: &Path) -> Result<Self, EmbedError> {
        if !base_path.exists() {
            create_dir_all(base_path)
                .map_err(|e| EmbedError::DiskError(format!("failed to create {}: {e}", base_path.display())))?;
        }

        let index_path = base_path.join("embed_index.json");
        let mut store = Self {
            vectors: HashMap::new(),
            index_path: Some(index_path.clone()),
            enable_disk: true,
        };

        if index_path.exists() {
            store.load_from_disk()?;
        }

        Ok(store)
    }

    pub fn store(&mut self, id: String, vector: Vec<f32>, metadata: HashMap<String, String>) -> Result<(), EmbedError> {
        if vector.is_empty() {
            return Err(EmbedError::InvalidVector("vector cannot be empty".to_string()));
        }

        let entry = VectorEntry {
            id: id.clone(),
            vector,
            metadata,
            created_at: chrono::Utc::now().timestamp(),
            chain_ref: None,
        };

        self.vectors.insert(id, entry);

        if self.enable_disk {
            self.persist_to_disk()?;
        }

        Ok(())
    }

    pub fn upsert_entry(&mut self, entry: VectorEntry) -> Result<(), EmbedError> {
        if entry.vector.is_empty() {
            return Err(EmbedError::InvalidVector("vector cannot be empty".to_string()));
        }

        self.vectors.insert(entry.id.clone(), entry);
        if self.enable_disk {
            self.persist_to_disk()?;
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&VectorEntry> {
        self.vectors.get(id)
    }

    pub fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<(f32, VectorEntry)>, EmbedError> {
        if query.is_empty() {
            return Err(EmbedError::InvalidVector("query cannot be empty".to_string()));
        }

        let mut results: Vec<(f32, VectorEntry)> = self
            .vectors
            .values()
            .map(|entry| (cosine_similarity(query, &entry.vector), entry.clone()))
            .collect();

        results.sort_by(|a, b| b.0.total_cmp(&a.0));
        results.truncate(top_k);
        Ok(results)
    }

    pub fn list(&self) -> Vec<&VectorEntry> {
        self.vectors.values().collect()
    }

    pub fn delete(&mut self, id: &str) -> Result<bool, EmbedError> {
        let removed = self.vectors.remove(id).is_some();
        if removed && self.enable_disk {
            self.persist_to_disk()?;
        }
        Ok(removed)
    }

    pub fn clear(&mut self) -> Result<(), EmbedError> {
        self.vectors.clear();
        if self.enable_disk {
            self.persist_to_disk()?;
        }
        Ok(())
    }

    fn load_from_disk(&mut self) -> Result<(), EmbedError> {
        let Some(path) = self.index_path.as_ref() else {
            return Ok(());
        };

        let content = std::fs::read_to_string(path).map_err(|e| EmbedError::DiskError(e.to_string()))?;
        let entries: HashMap<String, VectorEntry> =
            serde_json::from_str(&content).map_err(|e| EmbedError::SerializationError(e.to_string()))?;
        self.vectors = entries;
        Ok(())
    }

    fn persist_to_disk(&self) -> Result<(), EmbedError> {
        if !self.enable_disk {
            return Ok(());
        }

        let Some(path) = self.index_path.as_ref() else {
            return Ok(());
        };

        let content =
            serde_json::to_string_pretty(&self.vectors).map_err(|e| EmbedError::SerializationError(e.to_string()))?;
        std::fs::write(path, content).map_err(|e| EmbedError::DiskError(e.to_string()))?;
        Ok(())
    }
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0_f32;
    let mut norm_a = 0.0_f32;
    let mut norm_b = 0.0_f32;

    for (va, vb) in a.iter().zip(b.iter()) {
        dot += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a.sqrt() * norm_b.sqrt())
}
