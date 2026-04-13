import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { upsertEnvVars } from '../../src/infra/config/env-file.js';

function scratchEnv(initial = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-env-file-'));
  const envPath = join(dir, '.env');
  if (initial) writeFileSync(envPath, initial);
  return envPath;
}

describe('upsertEnvVars', () => {
  it('creates a new .env file when one does not exist', () => {
    const envPath = join(mkdtempSync(join(tmpdir(), 'mv4-env-file-new-')), '.env');
    upsertEnvVars([{ key: 'FOO', value: 'bar' }], envPath);
    expect(readFileSync(envPath, 'utf8')).toBe('FOO=bar\n');
  });

  it('appends a new key when the file exists but key is absent', () => {
    const envPath = scratchEnv('EXISTING=value\n');
    upsertEnvVars([{ key: 'NEW_KEY', value: 'v' }], envPath);
    expect(readFileSync(envPath, 'utf8')).toBe('EXISTING=value\nNEW_KEY=v\n');
  });

  it('replaces an existing key in place, preserving surrounding content', () => {
    const envPath = scratchEnv('FIRST=1\nSECOND=old\nTHIRD=3\n');
    upsertEnvVars([{ key: 'SECOND', value: 'new' }], envPath);
    expect(readFileSync(envPath, 'utf8')).toBe('FIRST=1\nSECOND=new\nTHIRD=3\n');
  });

  it('handles multiple mutations in a single call (upsert mixed replace/append)', () => {
    const envPath = scratchEnv('PRESENT=old\n');
    upsertEnvVars(
      [
        { key: 'PRESENT', value: 'new' },
        { key: 'ABSENT', value: 'added' },
      ],
      envPath,
    );
    expect(readFileSync(envPath, 'utf8')).toBe('PRESENT=new\nABSENT=added\n');
  });

  it('does not clobber keys that share a prefix (regex anchoring)', () => {
    const envPath = scratchEnv('FOO=1\nFOO_BAR=2\n');
    upsertEnvVars([{ key: 'FOO', value: '99' }], envPath);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('FOO=99\n');
    expect(content).toContain('FOO_BAR=2\n');
  });
});
