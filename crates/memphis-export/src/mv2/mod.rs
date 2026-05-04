//! `.mv2` v0 container — writer / reader / track definitions.
//!
//! The split mirrors the plan's three-file sketch (`writer.rs`,
//! `reader.rs`, `tracks.rs`). `error.rs` is added so the public API
//! exposes a single typed error rather than `Box<dyn Error>` strings.

pub mod error;
pub mod reader;
pub mod tracks;
pub mod writer;
