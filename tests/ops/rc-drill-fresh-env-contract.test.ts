import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('rc drill fresh-env contract', () => {
  it('runs the RC drill from a clean shell environment and is used by release smoke', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const releaseSmoke = read(path.join('scripts', 'release-smoke.sh'));
    const freshEnvScript = read(path.join('scripts', 'rc-drill-fresh-env.sh'));
    const rcDrill = read(path.join('scripts', 'rc-drill.sh'));

    expect(pkg.scripts?.['ops:offline-acceptance']).toBe('./scripts/rc-drill.sh');
    expect(pkg.scripts?.['ops:offline-acceptance:fresh-env']).toBe('./scripts/rc-drill-fresh-env.sh');
    expect(pkg.scripts?.['ops:rc-drill:fresh-env']).toBe('./scripts/rc-drill-fresh-env.sh');
    expect(releaseSmoke).toContain('ops:rc-drill:fresh-env');

    expect(freshEnvScript).toContain('env_args=(');
    expect(freshEnvScript).toContain('  -i');
    expect(freshEnvScript).toContain('exec env "${env_args[@]}"');
    expect(freshEnvScript).toContain('XDG_CACHE_HOME=');
    expect(freshEnvScript).toContain('NPM_CONFIG_CACHE=');
    expect(freshEnvScript).toContain('NPM_CONFIG_USERCONFIG=');
    expect(freshEnvScript).toContain('MEMPHIS_RC_DRILL_MATRIX=');

    expect(rcDrill).toContain('export DEFAULT_PROVIDER="local-fallback"');
    expect(rcDrill).toContain('export RUST_EMBED_MODE="local"');
    expect(rcDrill).toContain('export OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"');
    expect(rcDrill).toContain('unset RUST_EMBED_PROVIDER_URL');
    expect(rcDrill).toContain('unset RUST_EMBED_PROVIDER_API_KEY');
    expect(rcDrill).toContain('unset RUST_EMBED_PROVIDER_MODEL');
    expect(rcDrill).toContain('http://$HOST:$PORT/api/journal');
    expect(rcDrill).toContain('http://$HOST:$PORT/api/search');
    expect(rcDrill).toContain('--provider ollama');
  });
});
