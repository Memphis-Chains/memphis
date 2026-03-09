use thiserror::Error;

pub const EMBEDDING_DIM: usize = 8;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EmbedError {
    #[error("text cannot be empty")]
    EmptyInput,
}

pub fn embed_text(text: &str) -> Result<Vec<f32>, EmbedError> {
    if text.trim().is_empty() {
        return Err(EmbedError::EmptyInput);
    }

    let mut out = vec![0.0_f32; EMBEDDING_DIM];
    for (idx, byte) in text.as_bytes().iter().enumerate() {
        out[idx % EMBEDDING_DIM] += *byte as f32;
    }

    let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in &mut out {
            *v /= norm;
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{embed_text, EmbedError, EMBEDDING_DIM};

    #[test]
    fn deterministic_for_same_input() {
        let a = embed_text("memphis deterministic").expect("embed a");
        let b = embed_text("memphis deterministic").expect("embed b");
        assert_eq!(a, b);
        assert_eq!(a.len(), EMBEDDING_DIM);
    }

    #[test]
    fn rejects_empty_input() {
        let out = embed_text("   ");
        assert_eq!(out, Err(EmbedError::EmptyInput));
    }
}
