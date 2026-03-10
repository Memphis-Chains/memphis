use memphis_embed::{cosine_similarity, VectorStore};
use std::collections::HashMap;

#[test]
fn test_store_and_retrieve() {
    let mut store = VectorStore::new();

    let mut metadata = HashMap::new();
    metadata.insert("chain".to_string(), "journal".to_string());
    metadata.insert("type".to_string(), "entry".to_string());

    let vector = vec![0.1, 0.2, 0.3, 0.4];
    store
        .store("test1".to_string(), vector.clone(), metadata.clone())
        .unwrap();

    let retrieved = store.get("test1").unwrap();
    assert_eq!(retrieved.vector, vector);
}

#[test]
fn test_search_similarity() {
    let mut store = VectorStore::new();

    let vec1 = vec![1.0, 0.0, 0.0, 0.0];
    let vec2 = vec![0.9, 0.1, 0.0, 0.0];
    let vec3 = vec![0.0, 0.0, 1.0, 0.0];

    store.store("vec1".to_string(), vec1, HashMap::new()).unwrap();
    store.store("vec2".to_string(), vec2, HashMap::new()).unwrap();
    store.store("vec3".to_string(), vec3, HashMap::new()).unwrap();

    let query = vec![1.0, 0.0, 0.0, 0.0];
    let results = store.search(&query, 3).unwrap();

    assert_eq!(results[0].1.id, "vec1");
    assert!(results[0].0 > 0.9);

    assert_eq!(results[2].1.id, "vec3");
    assert!(results[2].0 < 0.5);
}

#[test]
fn test_cosine_similarity() {
    let a = vec![1.0, 0.0, 0.0, 0.0];
    let b = vec![1.0, 0.0, 0.0, 0.0];

    let similarity = cosine_similarity(&a, &b);
    assert!((similarity - 1.0).abs() < 0.01);

    let c = vec![0.0, 1.0, 0.0, 0.0];
    let similarity = cosine_similarity(&a, &c);
    assert!(similarity.abs() < 0.01);
}

#[test]
fn test_delete_vector() {
    let mut store = VectorStore::new();

    let vector = vec![0.1, 0.2, 0.3];
    store
        .store("test1".to_string(), vector.clone(), HashMap::new())
        .unwrap();

    assert!(store.get("test1").is_some());

    let deleted = store.delete("test1").unwrap();
    assert!(deleted);

    assert!(store.get("test1").is_none());
}
