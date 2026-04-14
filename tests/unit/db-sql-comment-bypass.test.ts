import { describe, expect, it } from 'vitest';

import { validateSql } from '../../src/mcp/tools/db.js';

/**
 * Regression net for Codex P1 against PR #76: the SQL safety filter only
 * checked `trim().toUpperCase().startsWith('DROP ' | 'ALTER ')`, so any SQL
 * comment in front of the destructive keyword bypassed the guard. The fix
 * strips block / line comments before the prefix check.
 *
 * Tests target `validateSql` directly so we don't have to stand up a real
 * SQLite database — the guard fires before any DB I/O.
 */

describe('validateSql — SQL comment bypass guard', () => {
  it.each([
    '/* x */ DROP TABLE foo',
    '/*x*/DROP TABLE foo',
    '   /* multi\n   line */DROP TABLE bar',
    '-- evil comment\nDROP TABLE qux',
    '--\nDROP TABLE x',
    '/*sql*/--also\nDROP TABLE y',
    '/* x */ ALTER TABLE foo ADD COLUMN evil TEXT',
    '-- x\nALTER TABLE foo DROP COLUMN safe',
    '   --comment\n  /*more*/ DROP TABLE z',
  ])('rejects DROP/ALTER hidden behind comments: %s', (sql) => {
    expect(validateSql(sql, 'execute')).toMatch(/DROP and ALTER statements are blocked/);
  });

  it.each([
    'DROP TABLE foo',
    'ALTER TABLE foo ADD COLUMN x INT',
    '  drop table foo',
    'DROP\tTABLE foo',
    'DROP\nTABLE foo',
  ])('blocks plain DROP / ALTER (regression check): %s', (sql) => {
    expect(validateSql(sql, 'execute')).toMatch(/DROP and ALTER statements are blocked/);
  });

  it('allows SELECT (regression check)', () => {
    expect(validateSql('SELECT 1', 'query')).toBeUndefined();
  });

  it('allows comments before SELECT (regression check)', () => {
    expect(validateSql('/* benign */ SELECT 1', 'query')).toBeUndefined();
    expect(validateSql('-- benign\nSELECT 1', 'query')).toBeUndefined();
  });

  it("does not false-positive on a SELECT containing 'DROP' in a string literal", () => {
    expect(validateSql("SELECT 'DROP TABLE evil' AS s", 'query')).toBeUndefined();
  });

  it('rejects non-SELECT for query action (regression check)', () => {
    expect(validateSql('UPDATE foo SET a = 1', 'query')).toMatch(/SELECT, WITH, EXPLAIN, and PRAGMA/);
  });
});
