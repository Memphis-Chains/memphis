/**
 * Tests for src/security/ modules:
 * - constant-time.ts (timing-safe comparison)
 * - unicode-normalizer.ts (NFC normalization)
 * - integrity.ts (chain integrity verification)
 * - request-limits.ts (request size validation)
 */

import { createHash } from 'node:crypto';
import { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { stableStringify } from '../../src/core/stable-stringify.js';
import {
  constantTimeCompare,
  constantTimeBufferCompare,
  secureCompare,
} from '../../src/security/constant-time.js';
import { IntegrityManager } from '../../src/security/integrity.js';
import { DEFAULT_SIZE_LIMITS, RequestSizeValidator } from '../../src/security/request-limits.js';
import { normalizeToNfc, trimAndNormalizeToNfc } from '../../src/security/unicode-normalizer.js';

// --- constant-time ---

describe('constantTimeCompare', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeCompare('hello', 'hello')).toBe(true);
  });

  it('returns false for unequal strings', () => {
    expect(constantTimeCompare('hello', 'world')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(constantTimeCompare('short', 'a much longer string')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(constantTimeCompare('', '')).toBe(true);
  });

  it('returns false for non-string inputs', () => {
    expect(constantTimeCompare(null as unknown as string, 'a')).toBe(false);
    expect(constantTimeCompare('a', undefined as unknown as string)).toBe(false);
  });

  it('handles unicode strings', () => {
    expect(constantTimeCompare('café', 'café')).toBe(true);
    expect(constantTimeCompare('café', 'cafe')).toBe(false);
  });
});

describe('constantTimeBufferCompare', () => {
  it('returns true for equal buffers', () => {
    expect(constantTimeBufferCompare(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });

  it('returns false for unequal buffers', () => {
    expect(constantTimeBufferCompare(Buffer.from('abc'), Buffer.from('xyz'))).toBe(false);
  });

  it('returns false for different length buffers', () => {
    expect(constantTimeBufferCompare(Buffer.from('ab'), Buffer.from('abcd'))).toBe(false);
  });

  it('returns false for non-buffer inputs', () => {
    expect(constantTimeBufferCompare('abc' as unknown as Buffer, Buffer.from('abc'))).toBe(false);
  });
});

describe('secureCompare', () => {
  it('returns true for equal strings', () => {
    expect(secureCompare('secret-token', 'secret-token')).toBe(true);
  });

  it('returns false for unequal strings', () => {
    expect(secureCompare('secret-token', 'wrong-token')).toBe(false);
  });

  it('accepts Buffer inputs', () => {
    expect(secureCompare(Buffer.from('data'), Buffer.from('data'))).toBe(true);
    expect(secureCompare(Buffer.from('data'), Buffer.from('other'))).toBe(false);
  });

  it('returns false for different length inputs', () => {
    expect(secureCompare('short', 'a-much-longer-string')).toBe(false);
  });
});

// --- unicode-normalizer ---

describe('normalizeToNfc', () => {
  it('returns empty string for non-string input', () => {
    expect(normalizeToNfc(null)).toBe('');
    expect(normalizeToNfc(undefined)).toBe('');
    expect(normalizeToNfc(123)).toBe('');
  });

  it('normalizes composed unicode to NFC', () => {
    // é as e + combining accent (NFD) vs precomposed é (NFC)
    const nfd = 'e\u0301'; // decomposed
    const nfc = '\u00e9'; // precomposed
    expect(normalizeToNfc(nfd)).toBe(nfc);
  });

  it('passes through ASCII unchanged', () => {
    expect(normalizeToNfc('hello world')).toBe('hello world');
  });
});

describe('trimAndNormalizeToNfc', () => {
  it('trims whitespace and normalizes', () => {
    expect(trimAndNormalizeToNfc('  hello  ')).toBe('hello');
  });

  it('returns empty for non-string', () => {
    expect(trimAndNormalizeToNfc(null)).toBe('');
  });
});

// --- integrity ---

describe('IntegrityManager', () => {
  const manager = new IntegrityManager();

  function makeBlock(
    index: number,
    data: unknown,
    previousHash: string,
  ): { index: number; timestamp: string; data: unknown; hash: string; previousHash: string } {
    const blockData = stableStringify({
      index,
      timestamp: '2026-01-01T00:00:00Z',
      data,
      previousHash,
    });
    const hash = createHash('sha256').update(blockData).digest('hex');
    return { index, timestamp: '2026-01-01T00:00:00Z', data, hash, previousHash };
  }

  it('verifies a valid single-block chain', async () => {
    const block = makeBlock(0, { msg: 'genesis' }, '0');
    const result = await manager.verifyChainIntegrity({ blocks: [block] });
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.blockCount).toBe(1);
  });

  it('verifies a valid multi-block chain', async () => {
    const b0 = makeBlock(0, { msg: 'genesis' }, '0');
    const b1 = makeBlock(1, { msg: 'second' }, b0.hash);
    const result = await manager.verifyChainIntegrity({ blocks: [b0, b1] });
    expect(result.isValid).toBe(true);
  });

  it('detects hash tampering', async () => {
    const b0 = makeBlock(0, { msg: 'genesis' }, '0');
    b0.hash = 'tampered_hash';
    const result = await manager.verifyChainIntegrity({ blocks: [b0] });
    expect(result.isValid).toBe(false);
    expect(result.errors[0].type).toBe('HASH_MISMATCH');
  });

  it('detects broken chain linkage', async () => {
    const b0 = makeBlock(0, { msg: 'genesis' }, '0');
    const b1 = makeBlock(1, { msg: 'second' }, 'wrong_previous_hash');
    const result = await manager.verifyChainIntegrity({ blocks: [b0, b1] });
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.type === 'CHAIN_BROKEN')).toBe(true);
  });

  it('repairs chain by removing corrupted blocks', async () => {
    const b0 = makeBlock(0, { msg: 'genesis' }, '0');
    const b1 = makeBlock(1, { msg: 'second' }, b0.hash);
    const b2 = makeBlock(2, { msg: 'third' }, 'wrong_hash');
    const chain = { blocks: [b0, b1, b2] };
    const result = await manager.repairChain(chain);
    expect(result.repaired).toBe(true);
    expect(result.removedBlocks).toBe(1);
    expect(chain.blocks).toHaveLength(2);
  });

  it('reports no repair needed for valid chain', async () => {
    const b0 = makeBlock(0, { msg: 'genesis' }, '0');
    const result = await manager.repairChain({ blocks: [b0] });
    expect(result.repaired).toBe(false);
  });
});

// --- request-limits ---

describe('RequestSizeValidator', () => {
  const validator = new RequestSizeValidator();

  function mockRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      url: '/api/test',
      headers: {},
      ...overrides,
    } as IncomingMessage;
  }

  it('accepts normal requests', () => {
    const result = validator.validateRequest(mockRequest());
    expect(result.valid).toBe(true);
  });

  it('rejects URLs exceeding max length', () => {
    const result = validator.validateRequest(mockRequest({ url: '/' + 'a'.repeat(3000) }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('URL too long');
  });

  it('rejects oversized query strings', () => {
    const result = validator.validateRequest(mockRequest({ url: '/api?' + 'q='.repeat(600) }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Query string too long');
  });

  it('rejects oversized content-length', () => {
    const result = validator.validateRequest(
      mockRequest({ headers: { 'content-length': '999999999' } }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Request body too large');
  });

  it('rejects oversized headers', () => {
    const bigHeaders: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      bigHeaders[`x-custom-${i}`] = 'a'.repeat(200);
    }
    const result = validator.validateRequest(mockRequest({ headers: bigHeaders }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Headers too large');
  });

  it('validates field names and values', () => {
    expect(validator.validateField('ok', 'value').valid).toBe(true);
    expect(validator.validateField('a'.repeat(300), 'val').valid).toBe(false);
    expect(validator.validateField('key', 'x'.repeat(20000)).valid).toBe(false);
  });

  it('uses default size limits', () => {
    expect(DEFAULT_SIZE_LIMITS.maxBodySize).toBe(10 * 1024 * 1024);
    expect(DEFAULT_SIZE_LIMITS.maxUrlLength).toBe(2048);
  });

  it('accepts custom limits', () => {
    const strict = new RequestSizeValidator({ ...DEFAULT_SIZE_LIMITS, maxUrlLength: 100 });
    const result = strict.validateRequest(mockRequest({ url: '/' + 'a'.repeat(150) }));
    expect(result.valid).toBe(false);
  });
});
