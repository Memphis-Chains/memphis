import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Two guards answer the same question from two different files, and a
 * guard that only exists in one of them is a guard with a hole.
 *
 * Measured 2026-10-09: `.gitignore` listed `*.pem` and `*.key` while
 * `pii-scan.sh` matched neither, because neither list had `.htpasswd`.
 * `sites/memphis-v5/docs/internal/.htpasswd` — a real password hash — sat
 * on the public default branch. Either guard alone would not have caught
 * it: gitignore does nothing for a file already in the index, and the scan
 * had no pattern for the extension.
 *
 * So this test asserts the two lists agree. Adding an extension to one and
 * forgetting the other is the exact regression that let the leak through.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function readPatterns(file: string): string[] {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function extensionsFromScanScript(): string[] {
  const src = readPatterns('scripts/pii-scan.sh');
  const line = src.split('\n').find((l) => l.startsWith('SECRET_FILE_TYPES='));
  if (!line) throw new Error('SECRET_FILE_TYPES not found in scripts/pii-scan.sh');
  // The line is a shell single-quoted assignment:
  //   SECRET_FILE_TYPES='\.(a|b|...)$'
  // Trim the prefix and the wrapping quotes, then take the alternation
  // between the escaped-dot prefix and the trailing anchor. Deliberately
  // avoids a regex: an escaped `\$` in a JS regex literal means a literal
  // dollar sign, which silently fails to match the end anchor — that cost
  // three debugging rounds the first time this was written.
  const quoted = line.slice('SECRET_FILE_TYPES='.length).trim();
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) {
    throw new Error(`unparseable SECRET_FILE_TYPES line: ${line}`);
  }
  const pattern = quoted.slice(1, -1);
  const body = pattern.replace(/^\\\./, '').replace(/\$$/, '');
  return body.replace(/[()]/g, '').split('|').filter(Boolean).sort();
}

function extensionsFromGitignore(): string[] {
  return readPatterns('.gitignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\*\.[a-z0-9_]+$/.test(line))
    .map((line) => line.replace(/^\*\./, ''))
    .sort();
}

describe('credential file types — gitignore and the scan agree', () => {
  it('gitignore covers every extension the scan blocks', () => {
    const scan = extensionsFromScanScript();
    const ignored = extensionsFromGitignore();
    // `gnupg` and `kwallet` in the scan are directory names, not extensions,
    // so they have no `*.ext` form to ignore.
    const scanExtensions = scan.filter((ext) => ext !== 'gnupg' && ext !== 'kwallet');
    const missing = scanExtensions.filter((ext) => !ignored.includes(ext));
    expect(
      missing,
      `add *.${missing.join(
        ', *.',
      )} to .gitignore — pii-scan blocks it but gitignore would let it be staged`,
    ).toEqual([]);
  });

  it('the extensions the leak actually involved are present in both', () => {
    // The 2026-10-09 leak: `.htpasswd`. If this test ever fails, the
    // password-hash class is unguarded again.
    const scan = extensionsFromScanScript();
    const ignored = extensionsFromGitignore();
    expect(scan).toContain('htpasswd');
    expect(ignored).toContain('htpasswd');
  });

  it('does not ignore ordinary configuration files that merely contain the words', () => {
    const ignored = extensionsFromGitignore();
    for (const innocent of ['json', 'yaml', 'toml', 'md', 'ts']) {
      expect(ignored, `*.${innocent} must stay committable`).not.toContain(innocent);
    }
  });
});
