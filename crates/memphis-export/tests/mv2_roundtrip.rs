//! Q1 exit gate test — `cargo test -p memphis-export -- mv2_roundtrip_minimal`.
//!
//! Pins the writer→reader contract that the operator's `memphis export
//! --format=mv2` relies on. If this test breaks, either the on-disk
//! layout drifted (bump `MV2_VERSION` + memvid-core integration plan)
//! or a panic surfaced before the eager error path got a chance.

use memphis_export::{Mv2Error, Mv2Reader, Mv2Record, Mv2Writer, Track};
use serde_json::json;

#[test]
fn mv2_roundtrip_minimal() {
    let mut writer = Mv2Writer::new();
    writer
        .append(&Mv2Record {
            track: Track::Journal,
            id: "j-001".into(),
            payload: json!({ "ts": "2026-05-04T08:00:00Z", "text": "live demo prep" }),
        })
        .unwrap();
    writer
        .append(&Mv2Record {
            track: Track::Chains,
            id: "block-aaa".into(),
            payload: json!({ "block": 42, "hash": "deadbeef" }),
        })
        .unwrap();
    writer
        .append(&Mv2Record {
            track: Track::Embeddings,
            id: "vec-001".into(),
            payload: json!({ "dim": 256, "model": "kartograf-v1" }),
        })
        .unwrap();

    let bytes = writer.finish();

    let reader = Mv2Reader::open(&bytes).expect("roundtrip parse");
    let records = reader.into_records();
    assert_eq!(records.len(), 3);
    assert_eq!(records[0].track, Track::Journal);
    assert_eq!(records[0].id, "j-001");
    assert_eq!(records[0].payload["text"], "live demo prep");
    assert_eq!(records[1].track, Track::Chains);
    assert_eq!(records[1].payload["block"], 42);
    assert_eq!(records[2].track, Track::Embeddings);
    assert_eq!(records[2].payload["model"], "kartograf-v1");
}

#[test]
fn mv2_rejects_vault_track() {
    let mut writer = Mv2Writer::new();
    let err = writer
        .append(&Mv2Record {
            track: Track::Vault,
            id: "secret".into(),
            payload: json!({ "k": "v" }),
        })
        .expect_err("vault must be denied");
    assert!(matches!(err, Mv2Error::VaultDenied));
}

#[test]
fn mv2_rejects_bad_magic() {
    let buf = vec![0u8; 64];
    let err = Mv2Reader::open(&buf).expect_err("bad magic");
    assert!(matches!(err, Mv2Error::BadMagic));
}

#[test]
fn mv2_rejects_corrupted_body() {
    let mut writer = Mv2Writer::new();
    writer
        .append(&Mv2Record {
            track: Track::Journal,
            id: "j".into(),
            payload: json!({ "x": 1 }),
        })
        .unwrap();
    let mut bytes = writer.finish();
    // Flip a payload byte — header sha256 should catch it.
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    let err = Mv2Reader::open(&bytes).expect_err("checksum should fail");
    assert!(matches!(err, Mv2Error::ChecksumMismatch { .. }));
}

#[test]
fn mv2_handles_empty_export() {
    // No frames is valid — the operator may export an empty journal
    // before any conversation. Reader should return zero records.
    let writer = Mv2Writer::new();
    let bytes = writer.finish();
    let reader = Mv2Reader::open(&bytes).expect("empty roundtrip");
    assert_eq!(reader.count(), 0);
}
