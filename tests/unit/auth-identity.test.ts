import { describe, expect, it } from 'vitest';

import { normalizeIdentity } from '../../src/infra/auth/identity.js';

describe('auth identity — normalizeIdentity', () => {
  it('throws on empty input', () => {
    expect(() => normalizeIdentity('')).toThrow();
  });

  it('throws on whitespace-only input', () => {
    expect(() => normalizeIdentity('   ')).toThrow();
  });

  it('recognizes and lowercases valid UUID', () => {
    const uuid = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';
    const result = normalizeIdentity(uuid);
    expect(result).toBe(uuid.toLowerCase());
  });

  it('preserves lowercase UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(normalizeIdentity(uuid)).toBe(uuid);
  });

  it('hashes non-UUID strings to SHA256 hex', () => {
    const result = normalizeIdentity('admin@example.com');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent hash for same input', () => {
    const a = normalizeIdentity('test-user');
    const b = normalizeIdentity('test-user');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = normalizeIdentity('user-a');
    const b = normalizeIdentity('user-b');
    expect(a).not.toBe(b);
  });

  it('trims whitespace before processing', () => {
    const a = normalizeIdentity('  test-user  ');
    const b = normalizeIdentity('test-user');
    expect(a).toBe(b);
  });

  it('treats invalid UUID format as string (hashes)', () => {
    const result = normalizeIdentity('not-a-uuid-1234');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
