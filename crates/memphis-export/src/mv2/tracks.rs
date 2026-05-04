use serde::{Deserialize, Serialize};

use super::error::Mv2Error;

/// Track kind discriminator. Stored as a single byte in the container
/// header; the numeric values are part of the on-disk format and must
/// not be reordered without bumping `MV2_VERSION`.
///
/// `Vault` exists as a surface so callers can refer to it by name in
/// CLI flags, but the writer rejects it at runtime — see
/// [`Mv2Error::VaultDenied`]. Vault contents leave the runtime only via
/// `memphis vault export`, which writes the encrypted envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    Journal = 0,
    Chains = 1,
    Embeddings = 2,
    Vault = 3,
}

impl Track {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u8(byte: u8) -> Result<Self, Mv2Error> {
        match byte {
            0 => Ok(Track::Journal),
            1 => Ok(Track::Chains),
            2 => Ok(Track::Embeddings),
            3 => Ok(Track::Vault),
            other => Err(Mv2Error::InvalidTrackId(other)),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Track::Journal => "journal",
            Track::Chains => "chains",
            Track::Embeddings => "embeddings",
            Track::Vault => "vault",
        }
    }
}

/// One record in a track. The payload is JSON-shaped so the TS layer
/// can stringify whatever shape it wants; the writer treats the JSON
/// blob as opaque bytes (other than the round-trip parse during
/// validation).
///
/// `id` is the operator-facing handle (e.g. journal entry id, chain
/// block hash). It's surfaced in `Mv2Reader::iter()` so consumers can
/// dedupe across tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mv2Record {
    pub track: Track,
    pub id: String,
    pub payload: serde_json::Value,
}
