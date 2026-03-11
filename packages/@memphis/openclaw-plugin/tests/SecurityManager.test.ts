import { describe, expect, it } from 'vitest';

import { SecurityManager } from '../src/security.js';

describe('SecurityManager Unicode normalization', () => {
  it('normalizes canonically equivalent input before validation', () => {
    const manager = new SecurityManager();

    const composed = 'café';
    const decomposed = 'cafe\u0301';

    expect(manager.validateInput(composed)).toBe(true);
    expect(manager.validateInput(decomposed)).toBe(true);
  });

  it('normalizes userId in rate-limit keying', () => {
    const manager = new SecurityManager();

    const composed = 'usér';
    const decomposed = 'use\u0301r';

    for (let i = 0; i < 100; i++) {
      expect(manager.checkRateLimit(composed)).toBe(true);
    }

    // Should be blocked because decomposed form maps to same NFC key.
    expect(manager.checkRateLimit(decomposed)).toBe(false);
  });

  it('normalizes API path input before traversal/scope checks', () => {
    const manager = new SecurityManager();

    const decomposedPath = '/api/cafe\u0301/notes';
    expect(manager.sanitizePath(decomposedPath)).toBe('/api/café/notes');
  });
});
