import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};

it.each([
  ['quality-gate', false],
  ['quality-gate', true],
  ['cross-arch', false],
  ['cross-arch', true],
] as const)('sets up existing Rust for %s with cargo env file=%s', (job, hasEnvFile) => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-ci-rust-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'rustup'),
      '#!/bin/sh\nprintf "%s|%s\\n" "$*" "${RUST_SETUP_ENV_SEEN:-0}" >> "$TEST_RUST_SETUP_CALLS"\n',
      { mode: 0o755 },
    );
    if (hasEnvFile) {
      mkdirSync(join(root, '.cargo'));
      writeFileSync(join(root, '.cargo/env'), 'export RUST_SETUP_ENV_SEEN=1\n');
    }
    const script = workflow.jobs[job].steps.find((step) => step.name === 'Setup Rust')?.run;
    expect(script).toBeTypeOf('string');
    const calls = join(root, 'calls');
    const result = spawnSync('bash', ['-e', '-c', script!], {
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, TEST_RUST_SETUP_CALLS: calls },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const marker = hasEnvFile ? '1' : '0';
    expect(readFileSync(calls, 'utf8').split('\n').filter(Boolean)).toEqual([
      `toolchain install stable --profile minimal --no-self-update|${marker}`,
      `default stable|${marker}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
