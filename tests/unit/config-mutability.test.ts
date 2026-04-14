import { describe, expect, it } from 'vitest';

import {
  classifyField,
  isMutableAtRuntime,
  listKnownFields,
  requiresElevatedTier,
  requiresRestart,
} from '../../src/infra/config/mutability.js';

describe('config-mutability', () => {
  it('classifies hot, warm, cold and secret fields as expected', () => {
    expect(classifyField('GEN_TIMEOUT_MS')).toBe('hot');
    expect(classifyField('GEN_MAX_TOKENS')).toBe('hot');
    expect(classifyField('GEN_TEMPERATURE')).toBe('hot');
    expect(classifyField('OLLAMA_URL')).toBe('hot');
    // PR #105: LOG_LEVEL reclassified warm → hot when the
    // Pino + AppLogger registry walker shipped (hot-swap actually
    // takes effect now via post-apply hook).
    expect(classifyField('LOG_LEVEL')).toBe('hot');
    expect(classifyField('DEFAULT_PROVIDER')).toBe('hot');
    expect(classifyField('PORT')).toBe('cold');
    expect(classifyField('HOST')).toBe('cold');
    expect(classifyField('DATABASE_URL')).toBe('cold');
    expect(classifyField('ANTHROPIC_API_KEY')).toBe('secret');
    expect(classifyField('MEMPHIS_VAULT_PEPPER')).toBe('secret');
    expect(classifyField('MEMPHIS_API_TOKEN')).toBe('secret');
  });

  it('falls back to warm for unknown keys', () => {
    expect(classifyField('SOMETHING_NOT_IN_SCHEMA')).toBe('warm');
  });

  it('requiresRestart only true for cold fields', () => {
    expect(requiresRestart('PORT')).toBe(true);
    expect(requiresRestart('GEN_TIMEOUT_MS')).toBe(false);
    expect(requiresRestart('LOG_LEVEL')).toBe(false);
  });

  it('requiresElevatedTier only true for secret fields', () => {
    expect(requiresElevatedTier('ANTHROPIC_API_KEY')).toBe(true);
    expect(requiresElevatedTier('GEN_TIMEOUT_MS')).toBe(false);
    expect(requiresElevatedTier('PORT')).toBe(false);
  });

  it('isMutableAtRuntime is true for hot and warm, false for cold', () => {
    expect(isMutableAtRuntime('GEN_TIMEOUT_MS')).toBe(true);
    expect(isMutableAtRuntime('LOG_LEVEL')).toBe(true);
    expect(isMutableAtRuntime('PORT')).toBe(false);
    // Secret is not "freely mutable" — caller must check tier separately.
    expect(isMutableAtRuntime('ANTHROPIC_API_KEY')).toBe(false);
  });

  it('listKnownFields returns the full taxonomy sorted by key', () => {
    const fields = listKnownFields();
    expect(fields.length).toBeGreaterThan(50);
    for (let i = 1; i < fields.length; i += 1) {
      expect(fields[i]!.key.localeCompare(fields[i - 1]!.key)).toBeGreaterThanOrEqual(0);
    }
    const portField = fields.find((f) => f.key === 'PORT');
    expect(portField?.tier).toBe('cold');
  });
});
