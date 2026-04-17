import { createPinoLogger } from '../infra/logging/pino.js';
import { NapiChainAdapter } from '../infra/storage/rust-chain-adapter.js';
import type { Block } from '../memory/chain.js';

const logger = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Verify an ed25519 signature on a peer-origin chain block.
 *
 * Routes through the Rust `chain_validate` NAPI so the canonical-hash
 * computation and signature verification are identical to what the
 * local append path enforces. Returns:
 *   - true:  signature is cryptographically valid
 *   - false: signature is malformed, missing, or verification failed
 *
 * Failures are logged (not thrown) so the caller can decide whether to
 * reject the block vs fall back to MEMPHIS_SYNC_ACCEPT_UNSIGNED.
 */
export async function verifyChainBlockSignature(block: Block): Promise<boolean> {
  if (!block.signer || !block.signature) return false;
  try {
    const adapter = new NapiChainAdapter(process.env);
    // The Rust bridge's validateBlock re-computes the canonical hash
    // and verifies the ed25519 signature if signer/signature are
    // present. When REQUIRE_SIGNATURES is off, validateBlock still
    // verifies whenever signer+signature are supplied — which is
    // exactly what we want here.
    const result = adapter.validateBlock(block);
    if (result.valid) return true;
    logger.warn({
      event: 'sync.block.signature_invalid',
      chain: block.chain,
      index: block.index,
      signer: block.signer,
      errors: result.errors,
    });
    return false;
  } catch (error) {
    logger.warn({
      event: 'sync.block.signature_verify_error',
      chain: block.chain,
      index: block.index,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
