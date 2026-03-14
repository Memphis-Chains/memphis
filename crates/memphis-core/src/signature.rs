use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use thiserror::Error;

use crate::block::Block;
use crate::hash::compute_hash;

#[derive(Debug, Error)]
pub enum SignatureError {
    #[error("block has neither signer nor signature")]
    MissingSignature,
    #[error("signer and signature must both be present")]
    IncompleteSignature,
    #[error("invalid hex payload: {0}")]
    InvalidHex(#[from] hex::FromHexError),
    #[error("invalid signer key encoding")]
    InvalidSigner,
    #[error("invalid signature encoding")]
    InvalidSignature,
}

pub fn sign_block(block: &mut Block, signing_key_bytes: &[u8; 32]) -> Result<(), SignatureError> {
    let signing_key = SigningKey::from_bytes(signing_key_bytes);
    let verifying_key = signing_key.verifying_key();
    let canonical_hash = compute_hash(block);
    let signature = signing_key.sign(canonical_hash.as_bytes());

    block.hash = canonical_hash;
    block.signer = Some(hex::encode(verifying_key.to_bytes()));
    block.signature = Some(hex::encode(signature.to_bytes()));
    Ok(())
}

pub fn verify_block_signature(block: &Block) -> Result<bool, SignatureError> {
    let signer_hex = block.signer.as_ref();
    let signature_hex = block.signature.as_ref();

    match (signer_hex, signature_hex) {
        (None, None) => return Ok(false),
        (Some(_), None) | (None, Some(_)) => return Err(SignatureError::IncompleteSignature),
        (Some(_), Some(_)) => {}
    }

    let signer_hex = signer_hex.ok_or(SignatureError::MissingSignature)?;
    let signature_hex = signature_hex.ok_or(SignatureError::MissingSignature)?;

    let signer_bytes = hex::decode(signer_hex)?;
    let signer_key_bytes: [u8; 32] = signer_bytes
        .as_slice()
        .try_into()
        .map_err(|_| SignatureError::InvalidSigner)?;
    let verifying_key =
        VerifyingKey::from_bytes(&signer_key_bytes).map_err(|_| SignatureError::InvalidSigner)?;

    let signature_bytes = hex::decode(signature_hex)?;
    let signature = ed25519_dalek::Signature::from_slice(signature_bytes.as_slice())
        .map_err(|_| SignatureError::InvalidSignature)?;

    let canonical_hash = compute_hash(block);
    match verifying_key.verify(canonical_hash.as_bytes(), &signature) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::{sign_block, verify_block_signature};
    use crate::block::{Block, BlockData, BlockType};
    use crate::hash::compute_hash;

    fn sample_block() -> Block {
        let mut block = Block {
            index: 0,
            timestamp: "2026-03-08T21:00:00Z".to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "signed-block".to_string(),
                tags: vec!["security".to_string()],
            },
            prev_hash: "0".repeat(64),
            hash: String::new(),
            signer: None,
            signature: None,
        };
        block.hash = compute_hash(&block);
        block
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let mut block = sample_block();
        let signing_key = [7u8; 32];
        sign_block(&mut block, &signing_key).expect("signing should succeed");
        let is_valid = verify_block_signature(&block).expect("verification should succeed");
        assert!(is_valid);
    }

    #[test]
    fn verify_returns_false_when_signature_missing() {
        let block = sample_block();
        let is_valid = verify_block_signature(&block).expect("verify should not fail");
        assert!(!is_valid);
    }

    #[test]
    fn detects_tampered_content() {
        let mut block = sample_block();
        let signing_key = [9u8; 32];
        sign_block(&mut block, &signing_key).expect("signing should succeed");
        block.data.content = "tampered".to_string();

        let is_valid = verify_block_signature(&block).expect("verification should run");
        assert!(!is_valid);
    }
}
