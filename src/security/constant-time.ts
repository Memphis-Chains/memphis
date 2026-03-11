// Security: Constant-time comparison to prevent timing attacks

/**
 * Constant-time string comparison
 * Prevents timing attacks by always comparing full strings
 */
export function constantTimeCompare(a: string, b: string): boolean {
  // Ensure both are strings
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  // Length check (still constant-time)
  const lenA = Buffer.byteLength(a, 'utf8');
  const lenB = Buffer.byteLength(b, 'utf8');

  // Always compare full length to prevent length-based timing
  const maxLen = Math.max(lenA, lenB);
  const bufA = Buffer.alloc(maxLen, 0);
  const bufB = Buffer.alloc(maxLen, 0);
  
  bufA.write(a, 'utf8');
  bufB.write(b, 'utf8');

  // XOR comparison (constant-time)
  let result = 0;
  for (let i = 0; i < maxLen; i++) {
    result |= bufA[i] ^ bufB[i];
  }

  // Also compare lengths ( XOR with length diff)
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

  // Length check
  if (a.length !== b.length) {
    // Still compare to prevent timing
    const maxLen = Math.max(a.length, b.length);
    let result = 0;
    for (let i = 0; i < maxLen; i++) {
      const byteA = i < a.length ? a[i] : 0;
      const byteB = i < b.length ? b[i] : 0;
      result |= byteA ^ byteB;
    }
    return false; // Lengths differ
  }

  // XOR comparison
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
  const crypto = require('crypto');
  
  // Use built-in if available (Node.js 6.6+)
  if (crypto.timingSafeEqual) {
    const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
    const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
    
    if (bufA.length !== bufB.length) {
      return false;
    }
    
    return crypto.timingSafeEqual(bufA, bufB);
  }
  
  // Fallback to custom implementation
  if (typeof a === 'string' && typeof b === 'string') {
    return constantTimeCompare(a, b);
  }
  
  return constantTimeBufferCompare(a as Buffer, b as Buffer);
}
