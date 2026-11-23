//! The native arm of the chain-name contract, checked against the fixture
//! the TypeScript arm also reads.
//!
//! `tests/fixtures/chain-name-contract.json` holds the cases; the
//! TypeScript runner is `tests/unit/chain-name-contract.test.ts`.
//!
//! ## Why this test exists
//!
//! "What is a chain called?" had FOUR owners on this host and THREE
//! answers. The TypeScript registry had the plain-name rule; the native
//! arm carried a copy of it, with a copy of the archive rule beside it;
//! and the native runtime carried a THIRD rule which asked "does the name
//! end in `.backup-<digits>`?" and nothing else.
//!
//! That third rule is the bug. It refused `journal.backup-1784913076785`
//! (a stamp of digits) and ACCEPTED `cases.backup-2026-07-07T15-07-23-108Z`
//! (a stamp of a date) — so the treatment of an archive depended on the
//! SHAPE OF ITS TIMESTAMP rather than on what the directory was.
//!
//! MEASURED 2026-11-23 on the operator's host: the runtime's status
//! counted 11 504 blocks as live memory, the audit counted 11 975, and the
//! live chains hold 11 228. The 276-block gap was one archive of `cases`,
//! counted as if it were the chain itself. The same rule counted
//! `.archives` — the dot-directory the rotation writes its `.jsonl.gz`
//! files into — as a chain, so the cockpit listed it as one.
//!
//! The fix is ONE owner (`crates/memphis-paths/src/chain_names.rs`), ONE
//! artefact of cases, and TWO runners. Neither arm produces the artefact
//! alone, so neither can change it alone.

use memphis_paths::chain_names::{
    archive_chain_name, classify_chain_directory, is_chain_backup_directory, logical_chain_name,
    normalize_chain_name, ChainDirectoryKind, ARCHIVE_CHAIN_PART_PATTERN, ARCHIVE_SEPARATOR,
    ARCHIVE_STAMP_PATTERNS, CHAIN_NAME_ALIASES, MAX_CHAIN_NAME_LEN, PLAIN_CHAIN_NAME_PATTERN,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/chain-name-contract.json");

#[test]
fn the_native_arm_agrees_with_the_contract() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");
    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    let mut failures: Vec<String> = Vec::new();

    for case in cases {
        let name = case["name"].as_str().expect("every case must carry a name");
        let directory = case["directory"]
            .as_str()
            .expect("every case must carry a directory");
        let expected_kind = case["kind"].as_str().expect("every case must carry a kind");
        let expected_logical = case["logical"]
            .as_str()
            .expect("every case must carry a logical chain");
        let expected_normalized = case["normalized"]
            .as_str()
            .expect("every case must carry a normalized name");

        let actual_kind = classify_chain_directory(directory).as_str();
        if actual_kind != expected_kind {
            failures.push(format!(
                "{name}: {directory:?} is a {actual_kind}, the contract says {expected_kind}"
            ));
        }

        let actual_logical = logical_chain_name(directory);
        if actual_logical != expected_logical {
            failures.push(format!(
                "{name}: {directory:?} holds {actual_logical:?}, the contract says {expected_logical:?}"
            ));
        }

        // The reference a caller passes is trimmed and then aliased — the
        // convention both arms follow.
        let actual_normalized = normalize_chain_name(directory.trim());
        if actual_normalized != expected_normalized {
            failures.push(format!(
                "{name}: {directory:?} normalizes to {actual_normalized:?}, the contract says {expected_normalized:?}"
            ));
        }

        // The archive predicate and the classifier must not disagree.
        let is_archive = is_chain_backup_directory(directory);
        let classified_as_archive = actual_kind == ChainDirectoryKind::Archive.as_str();
        if is_archive != classified_as_archive {
            failures.push(format!(
                "{name}: {directory:?} is an archive by one rule and not by the other"
            ));
        }
        let archive_of = archive_chain_name(directory);
        if classified_as_archive && archive_of.is_none() {
            failures.push(format!(
                "{name}: {directory:?} is an archive but names no chain"
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "the native arm disagrees with the contract:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_native_arm_publishes_the_vocabulary_the_contract_records() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let vocabulary = &fixture["vocabulary"];

    let pattern = |key: &str| {
        vocabulary[key]
            .as_str()
            .unwrap_or_else(|| panic!("the contract must record {key}"))
    };

    assert_eq!(pattern("plainChainNamePattern"), PLAIN_CHAIN_NAME_PATTERN);
    assert_eq!(
        pattern("archiveChainPartPattern"),
        ARCHIVE_CHAIN_PART_PATTERN
    );
    assert_eq!(pattern("archiveSeparator"), ARCHIVE_SEPARATOR);
    assert_eq!(
        vocabulary["maxChainNameLength"]
            .as_u64()
            .expect("the contract must record the length limit"),
        MAX_CHAIN_NAME_LEN as u64
    );

    let stamps = vocabulary["archiveStampPatterns"]
        .as_array()
        .expect("the contract must record the stamp forms");
    assert_eq!(
        stamps.len(),
        ARCHIVE_STAMP_PATTERNS.len(),
        "the contract and the owner disagree about the stamp forms"
    );
    for (entry, pattern) in stamps.iter().zip(ARCHIVE_STAMP_PATTERNS.iter()) {
        assert_eq!(entry.as_str(), Some(*pattern));
    }

    let aliases = vocabulary["chainNameAliases"]
        .as_array()
        .expect("the contract must record the alias table");
    assert_eq!(
        aliases.len(),
        CHAIN_NAME_ALIASES.len(),
        "the contract and the owner disagree about the size of the alias table"
    );
    for (entry, (alias, canonical)) in aliases.iter().zip(CHAIN_NAME_ALIASES.iter()) {
        assert_eq!(entry["alias"].as_str(), Some(*alias));
        assert_eq!(entry["canonical"].as_str(), Some(*canonical));
    }
}
