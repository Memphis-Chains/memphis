// Chain Integrity Verification System
// Prevents tampering with memory blocks

import { createHash, createVerify } from 'crypto';

interface Block {
  index: number;
  timestamp: string;
  data: unknown;
  hash: string;
  previousHash: string;
  signature?: string;
  publicKey?: string;
}

interface Chain {
  blocks: Block[];
}

export class IntegrityManager {
  /**
   * Verify entire chain integrity
   * - Checks hash consistency
   * - Verifies block linkage
   * - Validates signatures (if present)
   */
  async verifyChainIntegrity(chain: Chain): Promise<IntegrityResult> {
    const errors: IntegrityError[] = [];

    for (let i = 0; i < chain.blocks.length; i++) {
      const block = chain.blocks[i];

      // 1. Verify hash
      const computedHash = this.computeHash(block);
      if (computedHash !== block.hash) {
        errors.push({
          type: 'HASH_MISMATCH',
          blockIndex: i,
          expected: block.hash,
          actual: computedHash,
          severity: 'CRITICAL',
        });
      }

      // 2. Verify previous hash linkage
      if (i > 0) {
        const prevBlock = chain.blocks[i - 1];
        if (block.previousHash !== prevBlock.hash) {
          errors.push({
            type: 'CHAIN_BROKEN',
            blockIndex: i,
            expected: prevBlock.hash,
            actual: block.previousHash,
            severity: 'CRITICAL',
          });
        }
      }

      // 3. Verify signature (if present)
      if (block.signature) {
        const isValid = await this.verifySignature(block);
        if (!isValid) {
          errors.push({
            type: 'INVALID_SIGNATURE',
            blockIndex: i,
            severity: 'HIGH',
          });
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      blockCount: chain.blocks.length,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Compute SHA-256 hash of block
   */
  private computeHash(block: Block): string {
    const blockData = JSON.stringify({
      index: block.index,
      timestamp: block.timestamp,
      data: block.data,
      previousHash: block.previousHash,
    });

    return createHash('sha256').update(blockData).digest('hex');
  }

  /**
   * Verify cryptographic signature
   */
  private async verifySignature(block: Block): Promise<boolean> {
    if (!block.signature || !block.publicKey) {
      return false;
    }

    try {
      const verify = createVerify('SHA256');
      verify.update(JSON.stringify(block.data));
      verify.end();

      return verify.verify(block.publicKey, block.signature, 'hex');
    } catch (error) {
      console.error('Signature verification failed:', error);
      return false;
    }
  }

  /**
   * Auto-repair chain (remove corrupted blocks)
   */
  async repairChain(chain: Chain): Promise<RepairResult> {
    const verification = await this.verifyChainIntegrity(chain);

    if (verification.isValid) {
      return { repaired: false, message: 'Chain is valid, no repair needed' };
    }

    // Find last valid block
    let lastValidIndex = -1;
    for (let i = 0; i < chain.blocks.length; i++) {
      const block = chain.blocks[i];

      // Check if this block is valid
      const computedHash = this.computeHash(block);
      if (computedHash !== block.hash) {
        break;
      }

      // Check linkage to previous
      if (i > 0 && block.previousHash !== chain.blocks[i - 1].hash) {
        break;
      }

      lastValidIndex = i;
    }

    // Remove corrupted blocks
    const removedCount = chain.blocks.length - (lastValidIndex + 1);
    chain.blocks = chain.blocks.slice(0, lastValidIndex + 1);

    return {
      repaired: true,
      removedBlocks: removedCount,
      remainingBlocks: chain.blocks.length,
      message: `Removed ${removedCount} corrupted blocks`,
    };
  }
}

// Types
export interface IntegrityResult {
  isValid: boolean;
  errors: IntegrityError[];
  blockCount: number;
  timestamp: string;
}

export interface IntegrityError {
  type: 'HASH_MISMATCH' | 'CHAIN_BROKEN' | 'INVALID_SIGNATURE';
  blockIndex: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  expected?: string;
  actual?: string;
}

export interface RepairResult {
  repaired: boolean;
  removedBlocks?: number;
  remainingBlocks?: number;
  message: string;
}
