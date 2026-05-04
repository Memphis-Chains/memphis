use thiserror::Error;

/// Errors emitted by [`super::writer::Mv2Writer`] and
/// [`super::reader::Mv2Reader`]. Surface choices:
///
/// - `BadMagic` / `UnsupportedVersion` are split because the operator
///   needs different remediation: foreign file vs. version drift after
///   memvid-core swap.
/// - `VaultDenied` is its own variant so the CLI can show "vault export
///   blocked by spec" rather than a generic "invalid track".
#[derive(Debug, Error)]
pub enum Mv2Error {
    #[error("not a memphis .mv2 file: bad magic")]
    BadMagic,

    #[error("unsupported .mv2 version: got {got}, this build supports {supported}")]
    UnsupportedVersion { got: u32, supported: u32 },

    #[error("truncated container at offset {offset} (need {need} more bytes)")]
    Truncated { offset: usize, need: usize },

    #[error("vault track is denylisted by Y1 spec — use `vault export` for encrypted dumps")]
    VaultDenied,

    #[error("invalid track id: {0}")]
    InvalidTrackId(u8),

    #[error("frame payload is not valid UTF-8 JSON: {0}")]
    BadFrame(#[from] serde_json::Error),

    #[error("frame id is not valid UTF-8: {0}")]
    InvalidIdEncoding(#[from] std::string::FromUtf8Error),

    #[error("checksum mismatch: container header claimed {expected} but body hashed {actual}")]
    ChecksumMismatch { expected: String, actual: String },
}
