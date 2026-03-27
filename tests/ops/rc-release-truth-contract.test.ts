import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('rc release truth contract', () => {
  it('keeps README and TUI guide aligned with the shipped Rust console', () => {
    const readme = read('README.md');
    const tuiGuide = read(path.join('docs', 'TUI-OPERATOR-GUIDE.md'));

    expect(readme).toContain('single-view operator cockpit with live native chat streaming');
    expect(readme).toContain('seven logical native surfaces');
    expect(readme).not.toContain('native operator chat parity remains the major unfinished TUI gap');

    expect(tuiGuide).toContain('memphis tui --check-only --json');
    expect(tuiGuide).toContain('single-view operator cockpit with seven logical native surfaces');
    expect(tuiGuide).toContain('plain-text chat responses stream into the transcript live');
    expect(tuiGuide).toContain('every TS-owned command documented in this guide is expected to be host-backed');
    expect(tuiGuide).not.toContain('screens` as a compatibility alias');
    expect(tuiGuide).not.toContain('Remaining parity work:');
  });

  it('keeps runtime and architecture docs aligned with memphis-operator ownership', () => {
    const runtimeSecurity = read(path.join('docs', 'RUNTIME-SECURITY-ARCHITECTURE.md'));
    const canonicalArchitecture = read(path.join('docs', 'CANONICAL-ARCHITECTURE.md'));

    expect(runtimeSecurity).toContain('### Rust operator layer');
    expect(runtimeSecurity).not.toContain('MCP, gateway, HTTP, CLI, and TUI adapters.');

    expect(canonicalArchitecture).toContain('the Rust TUI now runs on the native `memphis-operator` service layer');
    expect(canonicalArchitecture).not.toContain('is expected to move onto a native `memphis-operator` service layer');
  });

  it('keeps release docs on the RC drill and deprecated-install truth', () => {
    const releaseProcess = read(path.join('docs', 'RELEASE-PROCESS.md'));
    const releaseChecklist = read(path.join('docs', 'RELEASE-CHECKLIST.md'));
    const packagePublish = read(path.join('docs', 'PACKAGE-PUBLISH.md'));
    const testing = read(path.join('docs', 'TESTING-VERIFICATION.md'));
    const smoke = read(path.join('docs', 'MUST-PASS-SMOKE.md'));
    const fullInstallGuide = read(path.join('docs', 'FULL_INSTALL_GUIDE.md'));

    expect(releaseProcess).toContain('npm run ops:rc-drill:fresh-env');
    expect(releaseProcess).toContain('semantic recall');
    expect(releaseChecklist).toContain('npm run ops:rc-drill:fresh-env');
    expect(releaseChecklist).toContain('semantic recall and exact-search sanity');
    expect(releaseChecklist).toContain('memphis tui --check-only --json');
    expect(releaseChecklist).toContain('one documented TS-owned TUI extension-host command');
    expect(releaseProcess).toContain('packaged CLI');
    expect(releaseProcess).toContain('source-checkout RC drill remains the Rust TUI proof');
    expect(releaseProcess).toContain('one documented TS-owned TUI host command');
    expect(packagePublish).toContain('packaged CLI surface only');
    expect(packagePublish).toContain('npm run ops:rc-drill:fresh-env');
    expect(testing).toContain('npm run ops:rc-drill:fresh-env');
    expect(testing).toContain('memphis embed store --id verification-sample --value');
    expect(testing).toContain('memphis embed search --query "verification"');
    expect(smoke).toContain('npm run ops:rc-drill');

    expect(fullInstallGuide).toContain('Deprecated document.');
    expect(fullInstallGuide).toContain('OpenClaw is deprecated/downstream only');
    expect(fullInstallGuide).not.toContain('OpenClaw is the user-facing layer');
  });
});
