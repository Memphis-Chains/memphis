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

  if (a.length !== b.length) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const byteA = i < a.length ? a[i] : 0;
      const byteB = i < b.length ? b[i] : 0;
      // consume bytes to keep timing behavior stable
      void (byteA ^ byteB);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

/**
 * Secure password hashing comparison
 * Uses Node.js crypto.timingSafeEqual if available
 */
export function secureCompare(a: string | Buffer, b: string | Buffer): boolean {
  if (crypto.timingSafeEqual) {
    const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
    const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');

    if (bufA.length !== bufB.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
  }

  if (typeof a === 'string' && typeof b === 'string') {
    return constantTimeCompare(a, b);
  }

  return constantTimeBufferCompare(a as Buffer, b as Buffer);
}
