/**
 * Phase D1: vault-ref leak filter — `VAULT:` literals must never reach
 * downstream APIs as if they were real secrets. The 2026-04-20 Telegram
 * crash loop was the motivating incident; same pattern applies to
 * voice (HuggingFace token, Google TTS key) and HTTP API token auth.
 */

import { describe, expect, it } from 'vitest';

import { isUnresolvedVaultRef, readResolvedSecret } from '../../src/infra/config/vault-ref.js';

describe('isUnresolvedVaultRef', () => {
  it('flags VAULT:<name> literals (case-insensitive)', () => {
    expect(isUnresolvedVaultRef('VAULT:huggingface_api_token')).toBe(true);
    expect(isUnresolvedVaultRef('VAULT:foo')).toBe(true);
    expect(isUnresolvedVaultRef('vault:bar')).toBe(true);
    expect(isUnresolvedVaultRef('Vault:Baz')).toBe(true);
  });

  it('does not flag real secrets that happen to mention "vault"', () => {
    expect(isUnresolvedVaultRef('hf_realToken123')).toBe(false);
    expect(isUnresolvedVaultRef('mySecretWithVaultInside')).toBe(false);
    expect(isUnresolvedVaultRef('keyVAULTtail')).toBe(false);
    expect(isUnresolvedVaultRef('')).toBe(false);
  });
});

describe('readResolvedSecret', () => {
  it('returns the trimmed value for real secrets', () => {
    expect(readResolvedSecret('  hf_realToken  ')).toBe('hf_realToken');
    expect(readResolvedSecret('plain-token')).toBe('plain-token');
  });

  it('returns null for unresolved vault refs', () => {
    expect(readResolvedSecret('VAULT:huggingface_api_token')).toBeNull();
    expect(readResolvedSecret('vault:foo')).toBeNull();
  });

  it('returns null for empty / whitespace / undefined', () => {
    expect(readResolvedSecret(undefined)).toBeNull();
    expect(readResolvedSecret('')).toBeNull();
    expect(readResolvedSecret('   ')).toBeNull();
  });
});
