use memphis_embed::EmbeddingCache;
use std::thread::sleep;
use std::time::Duration;

#[test]
fn test_cache_put_get() {
    let mut cache = EmbeddingCache::new(10, 60);

    let vector = vec![0.1, 0.2, 0.3];
    cache.put("test1".to_string(), vector.clone());

    let cached = cache.get("test1").unwrap();
    assert_eq!(cached, vector);
}

#[test]
fn test_cache_lru_eviction() {
    let mut cache = EmbeddingCache::new(2, 60);

    let vec1 = vec![1.0, 0.0];
    let vec2 = vec![0.0, 1.0];
    let vec3 = vec![0.5, 0.5];

    cache.put("key1".to_string(), vec1);
    cache.put("key2".to_string(), vec2);

    assert!(cache.get("key1").is_some());
    assert!(cache.get("key2").is_some());

    cache.put("key3".to_string(), vec3);

    assert!(cache.get("key1").is_none());
    assert!(cache.get("key2").is_some());
    assert!(cache.get("key3").is_some());
}

#[test]
fn test_cache_ttl_expiry() {
    let mut cache = EmbeddingCache::new(10, 1);

    let vector = vec![0.1, 0.2];
    cache.put("test".to_string(), vector);

    assert!(cache.get("test").is_some());

    sleep(Duration::from_millis(1100));

    assert!(cache.get("test").is_none());
}
