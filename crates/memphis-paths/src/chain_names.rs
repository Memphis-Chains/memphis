//! The chain-name vocabulary — ONE owner for every arm.
//!
//! ## Why this module exists
//!
//! "What is a chain called?" had FOUR answers on this host, and three of
//! them disagreed:
//!
//!   1. `src/memory/chain-catalog.ts` — `SAFE_CHAIN_NAME`, the plain-name
//!      rule (`^[A-Za-z0-9_-]{1,64}$`), with ten call sites;
//!   2. `crates/memphis-operator/src/chat_memory.rs` — `is_plain_chain_name`,
//!      a hand copy of (1), with a hand copy of the archive rule beside it;
//!   3. `crates/memphis-operator/src/runtime.rs` — `is_active_chain_name`,
//!      a THIRD rule, which answered "is this a live chain?" by asking
//!      "does the name end in `.backup-<digits>?`" and nothing else;
//!   4. `crates/memphis-paths/src/lib.rs` — the alias table, copied into
//!      `src/config/paths.ts` a fifth time.
//!
//! Rule (3) is where it hurt. It refused `journal.backup-1784913076785`
//! (a stamp of digits) and ACCEPTED `cases.backup-2026-07-07T15-07-23-108Z`
//! (a stamp of a date) — so the treatment of an archive depended on the
//! SHAPE OF ITS TIMESTAMP, not on what the directory was. Measured on the
//! operator's host: the runtime's status counted 11 504 blocks as live
//! memory, the audit counted 11 975, and the live chains hold 11 228. The
//! 276-block difference between the first two numbers is one archive of
//! `cases`, counted as if it were the chain itself. The same rule also
//! counted `.archives` — the dot-directory the rotation writes its
//! `.jsonl.gz` files into — as a chain, so the cockpit listed it as one.
//!
//! ## The rule, in one place
//!
//! A directory under `chains/` is one of three things:
//!
//!   - **Chain** — a plain chain name: 1 to 64 characters of
//!     `[A-Za-z0-9_-]`. The name of a live chain.
//!   - **Archive** — `<chain>.backup-<stamp>`, where `<chain>` carries the
//!     chain-name character set (without the sixty-four character limit,
//!     which is a rule about a LIVE chain) and `<stamp>` is either epoch
//!     milliseconds (`^[0-9]+$`) or the dated form
//!     (`YYYY-MM-DDTHH-MM-SS-mmmZ`, checked POSITION BY POSITION, because
//!     "the right characters in the wrong order" is not that form). An
//!     archive holds the same blocks the chain holds — it is a COPY, so it
//!     is never live memory.
//!   - **Foreign** — anything else: `.archives`, a name with a dot, a name
//!     with a space, a name longer than 64 characters. Not a chain, not an
//!     archive; the audit reports it and the verifier does not open it.
//!
//! ## What this module is NOT
//!
//! This is the NAME rule, not the TAXONOMY. Whether a plain name is a
//! chain Memphis KNOWS (`journal`, `decisions`, …) is a separate question,
//! answered by the registry in `src/memory/chain-catalog.ts`. The two were
//! conflated: `_quarantine` is a plain name, so this module calls it a
//! chain, and the taxonomy is what excludes it. Keeping the questions
//! apart is what makes both of them answerable.
//!
//! The data here (the pattern, the stamp forms, the alias table) is
//! PROJECTED into TypeScript by `scripts/sync-chain-name-contract.mts`,
//! which reads this module through the N-API bridge. The TypeScript arm is
//! therefore a projection and not a second hand-written copy, and the two
//! arms are checked against one artefact of cases:
//! `tests/fixtures/chain-name-contract.json`.

/// The longest a chain name may be.
///
/// Sixty-four characters, because that is what the TypeScript registry's
/// `SAFE_CHAIN_NAME` has always allowed and what the native rule had to
/// copy. A directory of sixty-five characters is not a chain.
pub const MAX_CHAIN_NAME_LEN: usize = 64;

/// The plain chain-name pattern, as a regular-expression SOURCE.
///
/// The source is published rather than the compiled rule so that the
/// TypeScript arm can build the same expression from it. It is a string
/// here and a `RegExp` there — one owner of the SOURCE, one projection of
/// it, and the artefact of cases that pins the behaviour.
pub const PLAIN_CHAIN_NAME_PATTERN: &str = "^[A-Za-z0-9_-]{1,64}$";

/// The epoch-milliseconds archive stamp: digits.
///
/// The rotation writes `<chain>.backup-<epoch millis>`; the older archive
/// writer wrote `<chain>.backup-<YYYY-MM-DDTHH-MM-SS-mmmZ>`.
pub const EPOCH_MILLIS_STAMP_PATTERN: &str = "^[0-9]+$";

/// The dated archive stamp: `YYYY-MM-DDTHH-MM-SS-mmmZ`.
///
/// Twenty-four characters in exactly that arrangement. The native rule
/// used to ask only for twenty-four characters that ended in `Z` and
/// contained a `T`, so it accepted stamps the registry refuses. The shape
/// is checked here POSITION BY POSITION, because "the right length, the
/// right characters, in the wrong order" is not the dated form.
///
/// The stamp is a shape, not a calendar: `2026-13-45T99-99-99-999Z` has
/// the dated SHAPE and is accepted as one. Nothing in Memphis reads it as
/// a date, and a rule that pretended to be a calendar would be a second
/// rule wearing a disguise.
pub const DATED_STAMP_PATTERN: &str = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$";

/// The chain-name CHARACTER SET, without the length limit.
///
/// The chain part of an ARCHIVE carries this set and nothing else — no
/// sixty-four character limit, because that limit is a rule about the name
/// of a LIVE chain, and an archive's directory name carries a suffix
/// besides. The house contract says so out loud
/// (`tests/fixtures/chain-verify-contract.json`): "an archive of a long
/// chain name is still an archive", with a chain part of seventy-one
/// characters.
pub const ARCHIVE_CHAIN_PART_PATTERN: &str = "^[A-Za-z0-9_-]+$";

/// The archive stamp forms, in the order the contract records them.
///
/// The epoch-milliseconds form first, then the dated one. The TypeScript
/// mirror publishes the same list, in the same order, so the artefact
/// compares like with like.
pub const ARCHIVE_STAMP_PATTERNS: &[&str] = &[EPOCH_MILLIS_STAMP_PATTERN, DATED_STAMP_PATTERN];

/// The separator between a chain name and its archive stamp.
pub const ARCHIVE_SEPARATOR: &str = ".backup-";

/// Chain name aliases — singular to canonical plural.
///
/// Shared with the TypeScript arm through the projection. The table used
/// to be written twice (here and in `src/config/paths.ts`) with a comment
/// on each side telling the reader to keep them in sync. Nobody keeps
/// comments in sync; a projection is kept in sync by a gate.
pub const CHAIN_NAME_ALIASES: &[(&str, &str)] = &[
    ("case", "cases"),
    ("decision", "decisions"),
    ("pattern", "patterns"),
    ("reflection", "reflections"),
];

/// What a directory under `chains/` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainDirectoryKind {
    /// A live chain: the name is a plain chain name.
    Chain,
    /// An archive of a chain: `<chain>.backup-<stamp>`.
    Archive,
    /// Not a chain and not an archive.
    Foreign,
}

impl ChainDirectoryKind {
    /// The spelling the vocabulary uses everywhere: in the artefact, in
    /// the projection, and in the two runners.
    pub fn as_str(self) -> &'static str {
        match self {
            ChainDirectoryKind::Chain => "chain",
            ChainDirectoryKind::Archive => "archive",
            ChainDirectoryKind::Foreign => "foreign",
        }
    }
}

/// The chain-name CHARACTER SET: `[A-Za-z0-9_-]`, one or more.
///
/// The set on its own, without the length limit — see
/// [`is_plain_chain_name`] for the limit and [`is_chain_backup_directory`]
/// for the one place the limit does not apply.
fn is_chain_name_chars(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// The plain chain name: 1 to 64 characters of `[A-Za-z0-9_-]`.
///
/// The rule the TypeScript registry's `SAFE_CHAIN_NAME` expressed and the
/// native arm copied. Both copies are gone; this is the copy that counts.
pub fn is_plain_chain_name(name: &str) -> bool {
    name.chars().count() <= MAX_CHAIN_NAME_LEN && is_chain_name_chars(name)
}

/// The dated archive stamp, checked position by position.
///
/// See [`DATED_STAMP_PATTERN`]. The positions are spelled out rather than
/// counted from the separators so that a rearranged stamp cannot pass.
fn is_dated_backup_stamp(stamp: &str) -> bool {
    let bytes = stamp.as_bytes();
    if bytes.len() != 24 {
        return false;
    }
    let digit = |index: usize| bytes[index].is_ascii_digit();
    // YYYY-MM-DD
    let date = digit(0)
        && digit(1)
        && digit(2)
        && digit(3)
        && bytes[4] == b'-'
        && digit(5)
        && digit(6)
        && bytes[7] == b'-'
        && digit(8)
        && digit(9);
    // T HH-MM-SS
    let time = bytes[10] == b'T'
        && digit(11)
        && digit(12)
        && bytes[13] == b'-'
        && digit(14)
        && digit(15)
        && bytes[16] == b'-'
        && digit(17)
        && digit(18);
    // -mmmZ
    let millis =
        bytes[19] == b'-' && digit(20) && digit(21) && digit(22) && bytes[23] == b'Z';
    date && time && millis
}

/// The epoch-milliseconds archive stamp: digits, and not empty.
fn is_epoch_millis_backup_stamp(stamp: &str) -> bool {
    !stamp.is_empty() && stamp.chars().all(|ch| ch.is_ascii_digit())
}

/// An archive directory: `<chain>.backup-<stamp>`.
///
/// The chain part must carry the chain-name CHARACTER SET — but NOT the
/// sixty-four character limit, which is a rule about the name of a LIVE
/// chain and not about the name of a copy of one. The house contract
/// (`tests/fixtures/chain-verify-contract.json`) says so out loud: "an
/// archive of a long chain name is still an archive", with a chain part of
/// seventy-one characters and a stamp of three digits. Both arms honoured
/// that before this module existed, and both honour it now.
pub fn is_chain_backup_directory(name: &str) -> bool {
    archive_chain_name(name).is_some()
}

/// The chain an archive directory holds.
///
/// `journal.backup-1784913076785` → `journal`. `None` when the name is
/// not an archive at all.
///
/// The archive suffix is a COPY marker, not part of the chain's identity:
/// the blocks inside it carry `chain: "journal"`, and that is what the
/// hash chain was built over. Reading the directory name as the chain
/// name is how a repair would rewrite every archived block's `chain`
/// field and invalidate the archive's hashes.
pub fn archive_chain_name(name: &str) -> Option<&str> {
    // The chain part may not contain a dot, so the FIRST separator is the
    // only one that can be the boundary.
    let (chain, stamp) = name.split_once(ARCHIVE_SEPARATOR)?;
    if !is_chain_name_chars(chain) {
        return None;
    }
    if is_epoch_millis_backup_stamp(stamp) || is_dated_backup_stamp(stamp) {
        return Some(chain);
    }
    None
}

/// The logical chain a directory holds.
///
/// `journal` → `journal`; `journal.backup-1784913076785` → `journal`. A
/// name that is not an archive holds itself.
pub fn logical_chain_name(name: &str) -> &str {
    archive_chain_name(name).unwrap_or(name)
}

/// Classify a directory under `chains/`.
///
/// The ONE question the runtime, the audit, the verifier and the cockpit
/// were each answering with their own rule.
pub fn classify_chain_directory(name: &str) -> ChainDirectoryKind {
    if is_plain_chain_name(name) {
        ChainDirectoryKind::Chain
    } else if is_chain_backup_directory(name) {
        ChainDirectoryKind::Archive
    } else {
        ChainDirectoryKind::Foreign
    }
}

/// Normalize a chain name through the alias table.
///
/// Returns the input verbatim when no alias applies. A pure function, so
/// the TypeScript arm can project the table and answer the same question.
pub fn normalize_chain_name(input: &str) -> &str {
    for (alias, canonical) in CHAIN_NAME_ALIASES {
        if input == *alias {
            return canonical;
        }
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_names_are_plain() {
        for name in ["journal", "decisions", "_quarantine", "journal-", "-journal", "JOURNAL"] {
            assert!(is_plain_chain_name(name), "{name} should be a plain chain name");
            assert_eq!(classify_chain_directory(name), ChainDirectoryKind::Chain);
        }
    }

    #[test]
    fn foreign_names_are_foreign() {
        for name in [
            "",
            ".archives",
            "journal chain",
            "journal.chain",
            "journal.backup-",
            "journal.backup-abc",
            "journal.backup-123abc",
            "journal.backup-123.backup-456",
        ] {
            assert!(
                !is_plain_chain_name(name),
                "{name} should not be a plain chain name"
            );
        }
    }

    #[test]
    fn the_length_limit_is_sixty_four() {
        let sixty_four = "a".repeat(MAX_CHAIN_NAME_LEN);
        let sixty_five = "a".repeat(MAX_CHAIN_NAME_LEN + 1);
        assert!(is_plain_chain_name(&sixty_four));
        assert!(!is_plain_chain_name(&sixty_five));
    }

    #[test]
    fn archives_are_archives_whatever_the_stamp_shape() {
        // The bug this module was written for: the old native rule
        // refused a digit stamp and accepted a dated one.
        assert_eq!(
            classify_chain_directory("journal.backup-1784913076785"),
            ChainDirectoryKind::Archive
        );
        assert_eq!(
            classify_chain_directory("cases.backup-2026-07-07T15-07-23-108Z"),
            ChainDirectoryKind::Archive
        );
    }

    #[test]
    fn an_archive_names_the_chain_it_holds() {
        assert_eq!(
            archive_chain_name("cases.backup-2026-07-07T15-07-23-108Z"),
            Some("cases")
        );
        assert_eq!(archive_chain_name("journal"), None);
        assert_eq!(
            logical_chain_name("cases.backup-2026-07-07T15-07-23-108Z"),
            "cases"
        );
        assert_eq!(logical_chain_name("journal"), "journal");
    }

    #[test]
    fn the_dated_stamp_is_checked_position_by_position() {
        assert!(is_dated_backup_stamp("2026-07-07T15-07-23-108Z"));
        assert!(!is_dated_backup_stamp("2026-07-07T15-07-23-108z"));
        assert!(!is_dated_backup_stamp("20260707T15-07-23-108Z"));
        assert!(!is_dated_backup_stamp("2026-07-07X15-07-23-108Z"));
        assert!(!is_dated_backup_stamp("2026-07-07T15-07-23-108"));
    }

    #[test]
    fn an_archive_of_a_long_chain_name_is_still_an_archive() {
        // The house contract says so: the sixty-four character limit is a
        // rule about the name of a LIVE chain, and an archive carries a
        // suffix besides.
        let long = "y".repeat(71);
        let name = format!("{long}.backup-123");
        assert!(!is_plain_chain_name(&long));
        assert_eq!(classify_chain_directory(&name), ChainDirectoryKind::Archive);
    }

    #[test]
    fn aliases_normalize_to_the_canonical_name() {
        assert_eq!(normalize_chain_name("case"), "cases");
        assert_eq!(normalize_chain_name("decision"), "decisions");
        assert_eq!(normalize_chain_name("pattern"), "patterns");
        assert_eq!(normalize_chain_name("reflection"), "reflections");
        assert_eq!(normalize_chain_name("journal"), "journal");
    }
}
