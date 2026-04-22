import { describe, expect, it } from 'vitest';

import {
  CHAIN_CATALOG,
  getChainDefinition,
  getChainNames,
  getExportableByDefaultChains,
  getSearchableChainNames,
  isKnownChainName,
} from '../../src/memory/chain-catalog.js';

describe('chain catalog (Sprint 0.5 G2)', () => {
  it('lists all 10 canonical Memphis chains', () => {
    const names = getChainNames();
    // Ten chains are on disk + referenced in code as of 2026-04-22:
    // journal, decisions, cases, patterns, reflections, system, collective,
    // proactive, insights, soul.
    expect(names).toHaveLength(10);
    expect(names).toContain('journal');
    expect(names).toContain('decisions');
    expect(names).toContain('cases');
    expect(names).toContain('patterns');
    expect(names).toContain('reflections');
    expect(names).toContain('system');
    expect(names).toContain('collective');
    expect(names).toContain('proactive');
    expect(names).toContain('insights');
    expect(names).toContain('soul');
  });

  it('every chain has a populated purpose + non-empty blockTypes', () => {
    for (const name of getChainNames()) {
      const def = CHAIN_CATALOG[name];
      expect(def.purpose.length).toBeGreaterThan(10);
      expect(def.blockTypes.length).toBeGreaterThan(0);
      // writeFrequency is a tri-value; searchable is boolean; consentDefault
      // is one of the three levels. Zod/TS would catch invalid values at
      // compile time, but explicitly assert runtime shape for the fixture.
      expect(['high', 'medium', 'low']).toContain(def.writeFrequency);
      expect(typeof def.searchable).toBe('boolean');
      expect(['exportable', 'local-only', 'anonymized']).toContain(def.consentDefault);
    }
  });

  it('system and soul chains are excluded from semantic search', () => {
    const searchable = getSearchableChainNames();
    // `system` is audit noise (tool_call, heartbeat) — polluting search
    // results. `soul` is identity/memory accessed via dedicated tools
    // (memphis_soul_read/write), not chain search.
    expect(searchable).not.toContain('system');
    expect(searchable).not.toContain('soul');
    // The remaining 8 chains are searchable.
    expect(searchable.length).toBe(8);
  });

  it('decisions/patterns/reflections/system/collective default to exportable consent', () => {
    const exportable = getExportableByDefaultChains();
    // These are training-corpus-safe by policy — operators export these by
    // default unless they explicitly mark individual blocks as private.
    expect(exportable).toContain('decisions');
    expect(exportable).toContain('patterns');
    expect(exportable).toContain('reflections');
    expect(exportable).toContain('system');
    expect(exportable).toContain('collective');
    expect(exportable).toContain('insights');
  });

  it('journal / cases / proactive / soul default to local-only', () => {
    // These chains carry operator-private content (personal thoughts, client
    // notes, workflow nudges, identity memory). Opting in to export requires
    // explicit per-block consent marking.
    expect(getChainDefinition('journal')?.consentDefault).toBe('local-only');
    expect(getChainDefinition('cases')?.consentDefault).toBe('local-only');
    expect(getChainDefinition('proactive')?.consentDefault).toBe('local-only');
    expect(getChainDefinition('soul')?.consentDefault).toBe('local-only');
  });

  it('isKnownChainName narrows string → ChainName for canonical entries', () => {
    expect(isKnownChainName('journal')).toBe(true);
    expect(isKnownChainName('decisions')).toBe(true);
    expect(isKnownChainName('insights')).toBe(true);
    expect(isKnownChainName('soul')).toBe(true);
    // Non-canonical names (including legacy / misspellings) return false.
    expect(isKnownChainName('ghost_chain')).toBe(false);
    expect(isKnownChainName('')).toBe(false);
  });

  it('isKnownChainName rejects prototype-chain property names (Codex follow-up)', () => {
    // Codex P2: prior implementation used `in` which inherited prototype
    // keys — operator-supplied strings like "toString" or "__proto__"
    // would narrow to ChainName and crash downstream code that expected
    // a real ChainDefinition. `Object.hasOwn` closes the hole.
    expect(isKnownChainName('toString')).toBe(false);
    expect(isKnownChainName('hasOwnProperty')).toBe(false);
    expect(isKnownChainName('__proto__')).toBe(false);
    expect(isKnownChainName('constructor')).toBe(false);
  });

  it('getChainDefinition returns undefined for unknown names', () => {
    expect(getChainDefinition('ghost_chain')).toBeUndefined();
    expect(getChainDefinition('proactive')).toBeDefined();
  });

  it('getChainDefinition returns undefined for prototype-chain property names (Codex follow-up)', () => {
    // Same class of bug: cast + index returned inherited Function.prototype
    // members (toString → function body) instead of undefined.
    expect(getChainDefinition('toString')).toBeUndefined();
    expect(getChainDefinition('__proto__')).toBeUndefined();
    expect(getChainDefinition('constructor')).toBeUndefined();
  });
});
