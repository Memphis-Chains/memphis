// Security: Constant-time comparison to prevent timing attacks

import * as crypto from 'node:crypto';

/**
 * Constant-time string comparison
 * Prevents timing attacks by always comparing full strings
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const lenA = Buffer.byteLength(a, 'utf8');
  const lenB = Buffer.byteLength(b, 'utf8');

  const maxLen = Math.max(lenA, lenB);
  const bufA = Buffer.alloc(maxLen, 0);
  const bufB = Buffer.alloc(maxLen, 0);

  bufA.write(a, 'utf8');
  bufB.write(b, 'utf8');

  let result = 0;
  for (let i = 0; i < maxLen; i++) {
    result |= bufA[i] ^ bufB[i];
  }

  result |= lenA ^ lenB;
  return result === 0;
}

/**
 * Constant-time buffer comparison
 */
export function constantTimeBufferCompare(a: Buffer, b: Buffer): boolean {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    return false;
  }

  let result = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < a.length ? a[i] : 0;
    const byteB = i < b.length ? b[i] : 0;
    result |= byteA ^ byteB;
  }

  result |= a.length ^ b.length;

  return result === 0;
}

/**
 * Secure string/buffer comparison using constant-time algorithm.
 * Uses Node.js crypto.timingSafeEqual which is resistant to timing attacks.
 */
export function secureCompare(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');

  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  try {
    return crypto.timingSafeEqual(paddedA, paddedB);
  } catch {
    return false;
  }
}
