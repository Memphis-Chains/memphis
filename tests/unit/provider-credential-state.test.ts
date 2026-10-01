import { describe, expect, it } from 'vitest';

import {
  classifyCredentialValue,
  classifyProviderCredential,
  describeCredentialState,
} from '../../src/providers/credential-state.js';

describe('classifyCredentialValue', () => {
  it('reports missing for undefined and null', () => {
    expect(classifyCredentialValue(undefined)).toBe('missing');
    expect(classifyCredentialValue(null)).toBe('missing');
  });

  it('reports missing for empty and whitespace-only values', () => {
    expect(classifyCredentialValue('')).toBe('missing');
    expect(classifyCredentialValue('   ')).toBe('missing');
    expect(classifyCredentialValue('\t\n')).toBe('missing');
  });

  // These are classified as `placeholder` rather than `missing`: they are
  // non-empty strings, so `isConfigured()` returns true for them, which is
  // exactly the failure mode this module exists to surface. Reporting
  // them as `missing` would hide that.
  it('reports placeholder for the literal strings editors substitute for a cleared value', () => {
    expect(classifyCredentialValue('none')).toBe('placeholder');
    expect(classifyCredentialValue('null')).toBe('placeholder');
    expect(classifyCredentialValue('undefined')).toBe('placeholder');
  });

  // Regression: ANTHROPIC_API_KEY=sk-test produced `ok: true` on
  // /v1/providers/health while a real POST returned HTTP 401 in 280 ms.
  it('reports placeholder for the sk-test scaffold value', () => {
    expect(classifyCredentialValue('sk-test')).toBe('placeholder');
  });

  it('reports placeholder regardless of case and surrounding whitespace', () => {
    expect(classifyCredentialValue('  SK-TEST  ')).toBe('placeholder');
    expect(classifyCredentialValue('ChangeMe')).toBe('placeholder');
    expect(classifyCredentialValue('XXX')).toBe('placeholder');
  });

  it('reports placeholder for the other known scaffold values', () => {
    for (const value of [
      'sk-test-key',
      'sk-ant-test',
      'test',
      'testing',
      'placeholder',
      'changeme',
      'change-me',
      'your-key-here',
      'your_api_key_here',
      'xxxx',
      'xxxxx',
      'todo',
    ]) {
      expect(classifyCredentialValue(value), value).toBe('placeholder');
    }
  });

  it('reports present for a plausible real key', () => {
    expect(classifyCredentialValue('sk-ant-api03-abc123')).toBe('present');
    expect(classifyCredentialValue('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe('present');
  });

  // Guards the "keep the list exact, not heuristic" decision: a real key
  // that merely contains a placeholder substring must not be flagged.
  it('does not flag a real key that contains a placeholder substring', () => {
    expect(classifyCredentialValue('sk-test-abc123def456')).toBe('present');
    expect(classifyCredentialValue('my-changeme-key-9f8e7d')).toBe('present');
  });
});

describe('classifyProviderCredential', () => {
  it('treats an unresolved key the same as an empty one', () => {
    expect(classifyProviderCredential(undefined)).toBe('missing');
    expect(classifyProviderCredential('')).toBe('missing');
  });

  it('passes a resolved vault key through as present', () => {
    expect(classifyProviderCredential('vault-plaintext-value')).toBe('present');
  });
});

describe('describeCredentialState', () => {
  it('gives a distinct, actionable sentence per state', () => {
    const missing = describeCredentialState('missing');
    const placeholder = describeCredentialState('placeholder');
    const present = describeCredentialState('present');

    expect(missing).not.toBe(placeholder);
    expect(placeholder).not.toBe(present);
    expect(missing).toMatch(/no credential/i);
    expect(placeholder).toMatch(/placeholder/i);
    expect(present).toMatch(/not verified/i);
  });
});
