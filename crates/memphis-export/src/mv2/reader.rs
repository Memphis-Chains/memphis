use sha2::{Digest, Sha256};

use crate::{MV2_MAGIC, MV2_VERSION};

use super::error::Mv2Error;
use super::tracks::{Mv2Record, Track};

const HEADER_LEN: usize = 4 + 4 + 32 + 4; // magic + version + sha + frame_count

/// Minimum bytes an empty frame consumes on the wire (track + id_len +
/// payload_len, with both length fields == 0). Used to derive a safe
/// upper bound on `frame_count` from the body size so a malicious
/// container can't cause a multi-GB `Vec::with_capacity` allocation
/// before any per-frame parse runs (Codex P2 #434).
const MIN_FRAME_BYTES: usize = 1 + 4 + 4;

#[derive(Debug)]
pub struct Mv2Reader {
    records: Vec<Mv2Record>,
}

impl Mv2Reader {
    /// Parse a complete `.mv2` buffer. Eager so the operator gets one
    /// shot at error reporting (truncation, checksum mismatch) before
    /// touching the data — matches the CLI's expectations where
    /// `memphis import` is a one-shot operation.
    pub fn open(buf: &[u8]) -> Result<Self, Mv2Error> {
        if buf.len() < HEADER_LEN {
            return Err(Mv2Error::Truncated {
                offset: 0,
                need: HEADER_LEN - buf.len(),
            });
        }
        if &buf[..4] != MV2_MAGIC {
            return Err(Mv2Error::BadMagic);
        }
        let version = u32_le(&buf[4..8]);
        if version != MV2_VERSION {
            return Err(Mv2Error::UnsupportedVersion {
                got: version,
                supported: MV2_VERSION,
            });
        }
        let claimed_hash = &buf[8..40];
        let frame_count = u32_le(&buf[40..44]);
        let body = &buf[HEADER_LEN..];

        let mut hasher = Sha256::new();
        hasher.update(body);
        let actual_hash = hasher.finalize();
        if claimed_hash != actual_hash.as_slice() {
            return Err(Mv2Error::ChecksumMismatch {
                expected: hex_encode(claimed_hash),
                actual: hex_encode(&actual_hash),
            });
        }

        // Cap the allocation hint at what the body can actually
        // contain. Header-claimed `frame_count` is untrusted; parsing
        // each frame still validates body bounds, but `with_capacity`
        // happens BEFORE any per-frame parse and would otherwise
        // attempt to reserve `frame_count * sizeof::<Mv2Record>()`
        // bytes on a malformed container. The min-bytes-per-frame cap
        // is a tight upper bound for the v0 layout.
        let claimed = frame_count as usize;
        let max_possible = body.len() / MIN_FRAME_BYTES;
        let capacity_hint = claimed.min(max_possible);

        let mut records = Vec::with_capacity(capacity_hint);
        let mut cursor = 0usize;
        for _ in 0..frame_count {
            records.push(parse_frame(body, &mut cursor)?);
        }
        // Codex R3 #434: `frame_count` lives in the header but is NOT
        // covered by `body_sha256` (hash is over `body` only). An
        // attacker can lower `frame_count` without invalidating the
        // checksum, dropping trailing frames silently. Reject any
        // container with leftover bytes after the parse loop —
        // frame_count is an integrity hint, not a truncation knob.
        if cursor != body.len() {
            return Err(Mv2Error::Truncated {
                offset: cursor + HEADER_LEN,
                need: body.len() - cursor,
            });
        }
        Ok(Self { records })
    }

    pub fn records(&self) -> &[Mv2Record] {
        &self.records
    }

    pub fn into_records(self) -> Vec<Mv2Record> {
        self.records
    }

    pub fn count(&self) -> usize {
        self.records.len()
    }
}

fn parse_frame(body: &[u8], cursor: &mut usize) -> Result<Mv2Record, Mv2Error> {
    let track_byte = read_u8(body, cursor)?;
    let track = Track::from_u8(track_byte)?;
    let id_len = read_u32(body, cursor)? as usize;
    let id_bytes = read_slice(body, cursor, id_len)?;
    // Codex R2 #434: don't lossy-decode. Replacement chars silently
    // change record IDs after corruption, which can collide with
    // legitimate IDs on import (`memphis import` dedupes by id) while
    // checksum still passes. Spec declares id_bytes as UTF-8 — fail
    // parse on invalid sequences instead of pretending success.
    let id = String::from_utf8(id_bytes.to_vec())?;
    let payload_len = read_u32(body, cursor)? as usize;
    let payload_bytes = read_slice(body, cursor, payload_len)?;
    let payload = serde_json::from_slice(payload_bytes)?;
    Ok(Mv2Record { track, id, payload })
}

fn read_u8(body: &[u8], cursor: &mut usize) -> Result<u8, Mv2Error> {
    if *cursor + 1 > body.len() {
        return Err(Mv2Error::Truncated {
            offset: *cursor + HEADER_LEN,
            need: 1,
        });
    }
    let byte = body[*cursor];
    *cursor += 1;
    Ok(byte)
}

fn read_u32(body: &[u8], cursor: &mut usize) -> Result<u32, Mv2Error> {
    if *cursor + 4 > body.len() {
        return Err(Mv2Error::Truncated {
            offset: *cursor + HEADER_LEN,
            need: 4 - (body.len() - *cursor),
        });
    }
    let value = u32_le(&body[*cursor..*cursor + 4]);
    *cursor += 4;
    Ok(value)
}

fn read_slice<'a>(body: &'a [u8], cursor: &mut usize, len: usize) -> Result<&'a [u8], Mv2Error> {
    if *cursor + len > body.len() {
        return Err(Mv2Error::Truncated {
            offset: *cursor + HEADER_LEN,
            need: len - (body.len() - *cursor),
        });
    }
    let slice = &body[*cursor..*cursor + len];
    *cursor += len;
    Ok(slice)
}

fn u32_le(slice: &[u8]) -> u32 {
    u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]])
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
