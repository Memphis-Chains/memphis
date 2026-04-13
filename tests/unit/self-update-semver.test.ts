import { describe, expect, it } from 'vitest';

import {
  compareSemVer,
  formatSemVer,
  isNewerVersion,
  parseSemVer,
} from '../../src/infra/self-update/semver.js';

describe('parseSemVer', () => {
  it.each([
    ['1.2.3', { major: 1, minor: 2, patch: 3 }],
    ['v1.2.3', { major: 1, minor: 2, patch: 3 }],
    ['10.0.5', { major: 10, minor: 0, patch: 5 }],
    ['v0.0.0', { major: 0, minor: 0, patch: 0 }],
    ['1.2.3-rc.1', { major: 1, minor: 2, patch: 3 }],
    ['1.2.3+build.42', { major: 1, minor: 2, patch: 3 }],
  ])('parses %s', (input, expected) => {
    expect(parseSemVer(input)).toEqual(expected);
  });

  it.each(['', '1', '1.2', 'v1.2', '1.2.x', 'banana', 'latest'])('rejects %s', (input) => {
    expect(parseSemVer(input)).toBeNull();
  });

  it('formats round-trip', () => {
    const v = parseSemVer('v3.4.5');
    expect(v).not.toBeNull();
    expect(formatSemVer(v!)).toBe('3.4.5');
  });
});

describe('compareSemVer', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.1', -1],
    ['1.0.1', '1.0.0', 1],
    ['1.1.0', '1.0.99', 1],
    ['2.0.0', '1.99.99', 1],
    ['v1.2.3', '1.2.3', 0],
    ['v1.2.3', 'v1.2.4', -1],
  ])('%s vs %s = %d', (a, b, expected) => {
    expect(compareSemVer(a, b)).toBe(expected);
  });

  it('returns null when either input is invalid', () => {
    expect(compareSemVer('1.0', '1.0.0')).toBeNull();
    expect(compareSemVer('1.0.0', 'banana')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it.each([
    ['1.0.0', '1.0.1', true],
    ['1.0.0', '2.0.0', true],
    ['1.0.0', '1.0.0', false],
    ['2.0.0', '1.99.99', false],
    ['v1.3.0', 'v1.3.5', true],
  ])('%s → %s newer: %s', (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected);
  });

  it('returns false when comparison fails (invalid input)', () => {
    expect(isNewerVersion('1.0.0', 'banana')).toBe(false);
  });
});
