use sha2::{Digest, Sha256};

use crate::{MV2_MAGIC, MV2_VERSION};

use super::error::Mv2Error;
use super::tracks::{Mv2Record, Track};

/// On-disk layout (v0):
///
/// ```text
/// 0..4   magic           = b"MV2\0"
/// 4..8   version         = u32 LE
/// 8..40  body_sha256     = 32 bytes
/// 40..44 frame_count     = u32 LE
/// 44..   frames[]
///   per frame:
///     0..1     track kind (u8)
///     1..5     id_len     (u32 LE)
///     5..5+id_len         id_bytes (UTF-8)
///     +0..4    payload_len (u32 LE)
///     +4..     payload_bytes (UTF-8 JSON)
/// ```
///
/// Body sha256 covers everything after byte 40 (the frame stream). It's
/// stored at write time so [`super::reader::Mv2Reader::open`] can
/// reject a corrupted file before parsing each frame.
pub struct Mv2Writer {
    frames: Vec<u8>,
    frame_count: u32,
}

impl Mv2Writer {
    pub fn new() -> Self {
        Self {
            frames: Vec::new(),
            frame_count: 0,
        }
    }

    /// Append a single record. `Track::Vault` is denied here so the
    /// CLI's vault-include flag fails loudly rather than silently
    /// shipping ciphertext into the wrong container.
    pub fn append(&mut self, record: &Mv2Record) -> Result<(), Mv2Error> {
        if record.track == Track::Vault {
            return Err(Mv2Error::VaultDenied);
        }
        let payload = serde_json::to_vec(&record.payload)?;
        let id_bytes = record.id.as_bytes();

        self.frames.push(record.track.as_u8());
        write_len(&mut self.frames, id_bytes.len() as u32);
        self.frames.extend_from_slice(id_bytes);
        write_len(&mut self.frames, payload.len() as u32);
        self.frames.extend_from_slice(&payload);
        self.frame_count += 1;
        Ok(())
    }

    /// Bulk variant — convenience for the NAPI bridge which receives
    /// records as a JSON array from TS.
    pub fn append_all(&mut self, records: &[Mv2Record]) -> Result<(), Mv2Error> {
        for record in records {
            self.append(record)?;
        }
        Ok(())
    }

    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Materialize the container. Owns the buffer so the caller can
    /// hand it straight to a Node `Buffer` (NAPI) or to `fs::write`.
    pub fn finish(self) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(&self.frames);
        let body_hash = hasher.finalize();

        let mut out = Vec::with_capacity(self.frames.len() + 44);
        out.extend_from_slice(MV2_MAGIC);
        out.extend_from_slice(&MV2_VERSION.to_le_bytes());
        out.extend_from_slice(&body_hash);
        out.extend_from_slice(&self.frame_count.to_le_bytes());
        out.extend_from_slice(&self.frames);
        out
    }
}

impl Default for Mv2Writer {
    fn default() -> Self {
        Self::new()
    }
}

fn write_len(buf: &mut Vec<u8>, len: u32) {
    buf.extend_from_slice(&len.to_le_bytes());
}
