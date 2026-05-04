//! Memphis `.mv2` export — Sprint G N12 scaffold.
//!
//! ## Why this crate exists
//!
//! Q1 exit gate (target 2026-07-28) requires that Memphis can serialize
//! a chosen subset of runtime state (journal, chains, embeddings) into a
//! single `.mv2` container that round-trips bit-for-bit. The eventual
//! encoder is memvid-core 2.0.x (frame codec + AI memory layer); the
//! integration plan is captured in `docs/dev/MV2-INTEGRATION.md`.
//!
//! Until that integration lands, this crate writes an in-house **v0**
//! container with the same high-level shape (magic header, version,
//! track table, length-prefixed frames). The v0 format is intentionally
//! simple so the swap to memvid-core stays a localized change inside
//! `mv2::writer` / `mv2::reader`.
//!
//! ## What is NOT in scope (Sprint G)
//!
//! - Compression. v0 stores raw UTF-8 JSON frames.
//! - Encryption. Vault entries are explicitly **rejected** (`Track::Vault`
//!   variant exists for surface completeness only — the writer denies
//!   them at runtime).
//! - Streaming write. The whole export is buffered in memory; that's
//!   fine for the operator's typical journal size (<50 MB) and matches
//!   what the CLI consumes today.
//!
//! ## Public API
//!
//! Two entry points: [`Mv2Writer`] (build a container) and
//! [`Mv2Reader`] (parse a container back into [`Mv2Record`]s). Both
//! travel through pure byte buffers so the NAPI bridge can hand them
//! straight to Node `Buffer`s without touching the filesystem.

pub mod mv2;

pub use mv2::error::Mv2Error;
pub use mv2::reader::Mv2Reader;
pub use mv2::tracks::{Mv2Record, Track};
pub use mv2::writer::Mv2Writer;

/// Format magic — read by `Mv2Reader::open` to reject foreign files
/// before allocating frame storage. Matches the plan's frame-codec
/// sketch in `docs/dev/MV2-INTEGRATION.md`.
pub const MV2_MAGIC: &[u8; 4] = b"MV2\0";

/// Container format version. Bump when the on-disk layout changes in a
/// way the reader cannot infer from the existing header. v0 is the
/// in-house bridge format; v1+ will reflect memvid-core integration.
pub const MV2_VERSION: u32 = 0;
