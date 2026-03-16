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
    #[error("signer not in allowlist: {0}")]
    SignerNotInAllowlist(String),
}

/// Verifies that the signer's public key is in the configured allowlist.
/// Returns Ok(true) if allowlist is empty (no restriction), Ok(false) if signer not found,
/// or Err if allowlist format is invalid.
pub fn verify_signer_in_allowlist(signer_hex: &str, allowlist: &[String]) -> Result<bool, SignatureError> {
    if allowlist.is_empty() {
        return Ok(true); // No allowlist = allow all
    }
    
    let signer_normalized = signer_hex.to_lowercase();
    for allowed in allowlist {
        if allowed.to_lowercase() == signer_normalized {
            return Ok(true);
        }
    }
    Ok(false)
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
    verify_block_signature_with_allowlist(block, &[])
}

/// Verifies block signature with an optional signer allowlist.
/// If allowlist is empty, any valid signature is accepted.
/// If allowlist has entries, signer MUST be in the allowlist.
pub fn verify_block_signature_with_allowlist(block: &Block, allowlist: &[String]) -> Result<bool, SignatureError> {
    let signer_hex = block.signer.as_ref();
    let signature_hex = block.signature.as_ref();

    match (signer_hex, signature_hex) {
        (None, None) => return Ok(false),
        (Some(_), None) | (None, Some(_)) => return Err(SignatureError::IncompleteSignature),
        (Some(_), Some(_)) => {}
    }

    let signer_hex = signer_hex.ok_or(SignatureError::MissingSignature)?;
    let signature_hex = signature_hex.ok_or(SignatureError::MissingSignature)?;

    // Check allowlist first
    if !allowlist.is_empty() {
        let in_allowlist = verify_signer_in_allowlist(signer_hex, allowlist)?;
        if !in_allowlist {
            return Err(SignatureError::SignerNotInAllowlist(signer_hex.clone()));
        }
    }

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
    use super::{sign_block, verify_block_signature, verify_block_signature_with_allowlist, verify_signer_in_allowlist};
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

    // Allowlist tests
    #[test]
    fn allowlist_empty_allows_any_signer() {
        let allowlist: Vec<String> = vec![];
        // Valid hex signer
        let result = verify_signer_in_allowlist("a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd", &allowlist);
        assert!(result.expect("should succeed") == true);
    }

    #[test]
    fn allowlist_accepts_matching_signer() {
        let signer = "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";
        let allowlist = vec![signer.to_string()];
        let result = verify_signer_in_allowlist(signer, &allowlist);
        assert!(result.expect("should succeed") == true);
    }

    #[test]
    fn allowlist_rejects_unknown_signer() {
        let allowlist = vec!["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()];
        let result = verify_signer_in_allowlist("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", &allowlist);
        assert!(result.expect("should succeed") == false);
    }

    #[test]
    fn allowlist_is_case_insensitive() {
        let allowlist = vec!["A1B2C3D4E5F6789012345678901234567890123456789012345678901234ABCD".to_string()];
        let result = verify_signer_in_allowlist("a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd", &allowlist);
        assert!(result.expect("should succeed") == true);
    }

    #[test]
    fn verify_with_allowlist_accepts_valid_signer() {
        let mut block = sample_block();
        let signing_key = [7u8; 32];
        sign_block(&mut block, &signing_key).expect("signing should succeed");
        
        // Get the signer from the block
        let signer = block.signer.as_ref().unwrap();
        let allowlist = vec![signer.clone()];
        
        let is_valid = verify_block_signature_with_allowlist(&block, &allowlist).expect("verification should succeed");
        assert!(is_valid);
    }

    #[test]
    fn verify_with_allowlist_rejects_unknown_signer() {
        let mut block = sample_block();
        let signing_key = [7u8; 32];
        sign_block(&mut block, &signing_key).expect("signing should succeed");
        
        // Use a different allowlist
        let allowlist = vec!["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string()];
        
        let result = verify_block_signature_with_allowlist(&block, &allowlist);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), super::SignatureError::SignerNotInAllowlist(_)));
    }
}
