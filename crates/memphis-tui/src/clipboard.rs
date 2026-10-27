//! Clipboard access for the operator cockpit.
//!
//! The TUI cannot use a system clipboard library: the process runs in a
//! raw-mode terminal, and the only portable way to set the terminal's
//! clipboard is the OSC 52 escape sequence, which the terminal emulator
//! (or a multiplexer) handles on our behalf.
//!
//! OSC 52 carries base64-encoded payload, so this module also owns a
//! small base64 encoder. It is deliberately dependency-free: the
//! `dep-freeze-check` workflow classifies every new dependency edge, and
//! an encoder this small is cheaper to own than to argue about.

/// Standard base64 alphabet (RFC 4648 §4).
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes as standard base64 with padding.
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64_ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(BASE64_ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(BASE64_ALPHABET[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Build the OSC 52 sequence that asks the terminal to place `text` in
/// the system clipboard.
///
/// The `c` parameter selects the clipboard target; `c` is the system
/// clipboard. The sequence is terminated with BEL, which is what every
/// terminal emulator in common use accepts.
pub fn osc52_copy(text: &str) -> Vec<u8> {
    let payload = base64_encode(text.as_bytes());
    format!("\x1b]52;c;{payload}\x07").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc_4648_test_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_the_full_byte_range() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let encoded = base64_encode(&bytes);
        assert_eq!(encoded.len(), 344);
        assert!(encoded.starts_with("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIj"));
        assert!(encoded.ends_with("9vf4+fr7/P3+/w=="));
    }

    #[test]
    fn osc52_wraps_the_payload_in_the_expected_envelope() {
        let sequence = osc52_copy("hi");
        assert_eq!(sequence, b"\x1b]52;c;aGk=\x07".to_vec());
    }

    #[test]
    fn osc52_preserves_unicode_payload() {
        // "ą" is two UTF-8 bytes; the encoded form must cover both.
        let sequence = osc52_copy("ą");
        let text = String::from_utf8(sequence).unwrap();
        assert!(text.starts_with("\x1b]52;c;"));
        assert!(text.ends_with("\x07"));
        assert!(text.contains(&base64_encode("ą".as_bytes())));
    }
}
