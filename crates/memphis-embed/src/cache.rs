use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

pub struct EmbeddingCache {
    cache: HashMap<String, CachedEmbedding>,
    access_order: VecDeque<String>,
    max_size: usize,
    ttl: Duration,
}

#[derive(Clone)]
struct CachedEmbedding {
    vector: Vec<f32>,
    created_at: Instant,
}

impl EmbeddingCache {
    pub fn new(max_size: usize, ttl_seconds: u64) -> Self {
        Self {
            cache: HashMap::new(),
            access_order: VecDeque::new(),
            max_size,
            ttl: Duration::from_secs(ttl_seconds),
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Vec<f32>> {
        if let Some(cached) = self.cache.get(key) {
            if cached.created_at.elapsed() < self.ttl {
                self.access_order.retain(|k| k != key);
                self.access_order.push_front(key.to_string());
                return Some(cached.vector.clone());
            }

            self.cache.remove(key);
            self.access_order.retain(|k| k != key);
        }

        None
    }

    pub fn put(&mut self, key: String, vector: Vec<f32>) {
        if self.max_size == 0 {
            return;
        }

        if self.cache.contains_key(&key) {
            self.access_order.retain(|k| k != &key);
        }

        if self.cache.len() >= self.max_size {
            if let Some(lru_key) = self.access_order.pop_back() {
                self.cache.remove(&lru_key);
            }
        }

        self.cache.insert(
            key.clone(),
            CachedEmbedding {
                vector,
                created_at: Instant::now(),
            },
        );
        self.access_order.push_front(key);
    }

    pub fn evict_expired(&mut self) -> usize {
        let expired: Vec<String> = self
            .cache
            .iter()
            .filter(|(_, cached)| cached.created_at.elapsed() >= self.ttl)
            .map(|(key, _)| key.clone())
            .collect();

        let count = expired.len();
        for key in expired {
            self.cache.remove(&key);
            self.access_order.retain(|k| k != &key);
        }

        count
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.cache.len(),
            max_size: self.max_size,
            ttl_seconds: self.ttl.as_secs(),
        }
    }
}

#[derive(Debug)]
pub struct CacheStats {
    pub entries: usize,
    pub max_size: usize,
    pub ttl_seconds: u64,
}
