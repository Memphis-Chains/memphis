import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('matrix pilot docs contract', () => {
  it('documents setup matrix in operator entrypoint docs', () => {
    const readme = readDoc('README.md');
    const gettingStarted = readDoc(path.join('docs', 'operator', 'GETTING-STARTED.md'));
    const cliReference = readDoc(path.join('docs', 'operator', 'CLI-REFERENCE.md'));

    expect(readme).toContain('setup matrix');
    expect(gettingStarted).toContain('setup matrix');
    expect(cliReference).toContain('setup matrix');
  });

  it('documents vault-backed matrix token configuration instead of fake plaintext access-token output', () => {
    const configuration = readDoc(path.join('docs', 'operator', 'CONFIGURATION.md'));
    const vaultCli = readDoc(path.join('docs', 'operator', 'VAULT-CLI.md'));

    expect(configuration).toContain('MEMPHIS_MATRIX_ACCESS_TOKEN');
    expect(configuration).toContain('VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN');
    expect(vaultCli).toContain('VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN');
  });

  it('keeps matrix pilot positioning bounded and trusted-pilot only', () => {
    const federation = readDoc(path.join('docs', 'dev', 'FEDERATION-KEY-EXCHANGE.md'));
    const releaseProcess = readDoc(path.join('docs', 'historical', 'RELEASE-PROCESS.md'));
    const releaseChecklist = readDoc(path.join('docs', 'historical', 'RELEASE-CHECKLIST.md'));
    const testing = readDoc(path.join('docs', 'dev', 'TESTING-VERIFICATION.md'));

    expect(federation).toContain('trusted-pilot');
    expect(federation).toContain('memphis setup matrix');
    expect(federation).toContain('not a `v1.0.0` GA blocker');
    expect(federation).toContain('does not certify public federation support');
    expect(releaseProcess).toContain('bounded Matrix trusted-pilot setup truth');
    expect(releaseChecklist).toContain('optional trusted-pilot check');
    expect(testing).toContain('optional bounded path');
    expect(testing).toContain('public-federation hardening remains explicitly deferred');
  });
});
