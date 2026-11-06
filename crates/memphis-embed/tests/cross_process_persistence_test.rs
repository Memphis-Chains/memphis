//! Cross-process persistence guarantees for the embed index.
//!
//! Every test uses a synthetic temporary index — no live runtime, no
//! `~/.memphis`, no network. The provider is the local deterministic
//! one, so no Kartograf model is involved and no vector space is mixed.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use memphis_embed::{EmbedConfig, EmbedError, EmbedPersistenceConfig, EmbedPipeline};

fn temp_index_path(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir()
        .join(format!(
            "memphis-embed-xproc-{name}-{}-{stamp}",
            std::process::id()
        ))
        .join("index-v1.json")
}

fn pipeline_for(path: &Path) -> EmbedPipeline {
    EmbedPipeline::with_persistence(
        EmbedConfig {
            dim: 8,
            ..EmbedConfig::default()
        },
        EmbedPersistenceConfig {
            enabled: true,
            index_path: path.to_path_buf(),
        },
    )
    .expect("pipeline")
}

fn ids_on_disk(path: &Path) -> Vec<String> {
    let reader = pipeline_for(path);
    let hits = reader.search("document corpus", 64).expect("search");
    hits.into_iter().map(|hit| hit.id).collect()
}

/// Regression for the reproduced bug: two independent writers that both
/// loaded the index BEFORE either wrote must not overwrite each other.
/// Before the fix, writer B's persist wrote its stale in-memory snapshot
/// and writer A's document disappeared from the index.
#[test]
fn two_writers_loaded_before_either_write_keep_both_documents() {
    let path = temp_index_path("two-writers");

    let mut writer_a = pipeline_for(&path);
    let mut writer_b = pipeline_for(&path);

    writer_a
        .upsert("doc-a", "first writer document")
        .expect("writer a upsert");
    writer_b
        .upsert("doc-b", "second writer document")
        .expect("writer b upsert");

    let ids = ids_on_disk(&path);
    assert!(
        ids.contains(&"doc-a".to_string()),
        "writer A's document was lost: {ids:?}"
    );
    assert!(
        ids.contains(&"doc-b".to_string()),
        "writer B's document was lost: {ids:?}"
    );
}

/// A deferred bulk upsert must merge only its own pending entries into
/// the LATEST persisted index — not flush a stale full in-memory
/// snapshot over another writer's work.
#[test]
fn bulk_flush_merges_pending_entries_into_the_latest_index() {
    let path = temp_index_path("bulk-flush");

    let mut bulk_writer = pipeline_for(&path);
    let mut other_writer = pipeline_for(&path);

    bulk_writer.set_auto_persist(false);
    other_writer
        .upsert("doc-other", "document written by the other process")
        .expect("other writer upsert");

    bulk_writer
        .upsert_many(vec![
            (
                "doc-bulk-1".to_string(),
                "bulk document one".to_string(),
                vec![],
            ),
            (
                "doc-bulk-2".to_string(),
                "bulk document two".to_string(),
                vec![],
            ),
        ])
        .expect("bulk upsert");
    bulk_writer.flush().expect("bulk flush");

    let ids = ids_on_disk(&path);
    assert!(
        ids.contains(&"doc-other".to_string()),
        "the other writer's document was lost by the bulk flush: {ids:?}"
    );
    assert!(
        ids.contains(&"doc-bulk-1".to_string()),
        "bulk document 1 missing: {ids:?}"
    );
    assert!(
        ids.contains(&"doc-bulk-2".to_string()),
        "bulk document 2 missing: {ids:?}"
    );
}

/// A corrupt index must fail closed: the upsert reports a real error
/// and the damaged file is left untouched (no destructive overwrite).
#[test]
fn corrupt_index_fails_closed_without_destroying_the_file() {
    let path = temp_index_path("corrupt");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    let corrupt = "{ not valid json";
    std::fs::write(&path, corrupt).expect("write corrupt");

    let mut pipeline = pipeline_for(&path);
    let error = pipeline
        .upsert("doc-a", "document that must not be written")
        .expect_err("upsert against a corrupt index must fail");

    assert!(
        matches!(error, EmbedError::SerializationError(_)),
        "unexpected error: {error:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&path).expect("read back"),
        corrupt,
        "the corrupt index must not be overwritten"
    );
}

/// An index written with a different embedding dimension must not be
/// merged into — that would mix vector spaces.
#[test]
fn dimension_mismatch_fails_closed() {
    let path = temp_index_path("dimension");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    let foreign = r#"{"version":1,"dim":999,"docs":[]}"#;
    std::fs::write(&path, foreign).expect("write foreign index");

    let mut pipeline = pipeline_for(&path);
    let error = pipeline
        .upsert("doc-a", "document that must not be written")
        .expect_err("upsert against a foreign-dimension index must fail");

    assert!(
        matches!(error, EmbedError::DiskError(_)),
        "unexpected error: {error:?}"
    );
    assert!(
        std::fs::read_to_string(&path)
            .expect("read back")
            .contains("999"),
        "the foreign index must not be overwritten"
    );
}

/// A reader that was already running must observe a write made by
/// another process — without dropping its own pending bulk writes.
#[test]
fn reader_refresh_observes_writes_from_another_process() {
    let path = temp_index_path("refresh");

    let mut reader = pipeline_for(&path);
    let mut writer = pipeline_for(&path);

    reader.set_auto_persist(false);
    reader
        .upsert_many(vec![(
            "doc-pending".to_string(),
            "pending document not yet flushed".to_string(),
            vec![],
        )])
        .expect("pending upsert");

    writer
        .upsert("doc-external", "external document from another process")
        .expect("external upsert");

    assert!(
        reader.refresh_from_disk().expect("refresh"),
        "the reader must notice the external write"
    );

    let hits = reader.search("document", 32).expect("search");
    let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
    assert!(
        ids.contains(&"doc-external"),
        "the external write was not observed: {ids:?}"
    );
    assert!(
        ids.contains(&"doc-pending"),
        "the refresh discarded a pending bulk write: {ids:?}"
    );
}

/// An explicit replacement (clear / rebuild) must refuse to run when
/// another writer changed the index since it was last read, instead of
/// silently deleting the newer work.
#[test]
fn replacement_fails_closed_when_another_writer_changed_the_index() {
    let path = temp_index_path("conflict");

    let mut replacer = pipeline_for(&path);
    let mut other_writer = pipeline_for(&path);

    other_writer
        .upsert("doc-other", "document written by the other process")
        .expect("other writer upsert");

    replacer.clear_in_memory_only();
    let error = replacer.flush().expect_err("replacement must fail closed");
    assert!(
        matches!(error, EmbedError::DiskError(_)),
        "unexpected error: {error:?}"
    );

    let ids = ids_on_disk(&path);
    assert!(
        ids.contains(&"doc-other".to_string()),
        "the other writer's document was deleted: {ids:?}"
    );
}

/// The lock file is created once and never removed — unlinking it would
/// let a later process lock a different inode.
#[test]
fn lock_file_is_created_and_never_removed() {
    let path = temp_index_path("lockfile");
    let mut pipeline = pipeline_for(&path);

    pipeline
        .upsert("doc-a", "document that creates the lock file")
        .expect("upsert");

    let lock_path = path.with_extension("lock");
    assert!(lock_path.exists(), "the lock file must exist");
    let before = std::fs::metadata(&lock_path).expect("metadata");

    pipeline
        .upsert("doc-b", "second document reusing the same lock")
        .expect("upsert");

    let after = std::fs::metadata(&lock_path).expect("metadata");
    assert!(lock_path.exists(), "the lock file must never be removed");
    assert_eq!(
        before.len(),
        after.len(),
        "the lock file must be reused, not recreated"
    );
}
