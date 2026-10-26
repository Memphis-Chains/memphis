import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

function fixture(failures: string[] = [], audit = true) {
  const root = mkdtempSync(join(tmpdir(), 'memphis-q2-gate-'));
  for (const path of ['scripts', 'bin', 'docs/security'])
    mkdirSync(join(root, path), { recursive: true });
  for (const name of ['quarterly-exit-test-q2.sh', 'quarterly-exit-test-q2.mjs'])
    copyFileSync(join('scripts', name), join(root, 'scripts', name));
  if (audit)
    writeFileSync(
      join(root, 'docs/security/AUDIT-2026-Q2.md'),
      'Synthetic acceptance audit fixture.',
    );
  writeFileSync(join(root, 'bin/failures.json'), JSON.stringify(failures));
  writeFileSync(
    join(root, 'bin/memphis.js'),
    `
    const fs = require('node:fs'), path = require('node:path');
    const failures = JSON.parse(fs.readFileSync(path.join(__dirname, 'failures.json')));
    const args = process.argv.slice(2), [command, sub] = args;
    if (process.env.MEMPHIS_API_TOKEN || process.env.MEMPHIS_VAULT_PEPPER || process.env.HOME === process.env.OPERATOR_HOME) process.exit(9);
    if (!process.env.MEMPHIS_DATA_DIR.startsWith(process.env.HOME + '/')) process.exit(9);
    const flag = (name) => args[args.indexOf(name) + 1];
    let result = { ok: true };
    if (command === 'kartograf' && sub === 'install' && failures.includes('checkpoint-install')) process.exit(1);
    if (command === 'kartograf' && sub === 'status') result = { active_checkpoint: failures.includes('active-checkpoint') ? null : 'signed-checkpoint' };
    if (command === 'kartograf' && sub === 'query') result = { embedding: [0.1, 0.2], topZone: 'vault', confidence: failures.includes('vault-query') ? 0.4 : 0.9 };
    if (command === 'doctor') result = failures.includes('bad-json') ? { checks: {} } : { checks: [{ name: 'embed_cascade_tier0', provider: failures.includes('cascade-tier0') ? 'ollama' : 'kartograf' }] };
    if (command === 'export' && args.includes('--format=mv2')) {
      if (failures.includes('mv2-export')) process.exit(1);
      fs.writeFileSync(flag('--output'), 'synthetic-mv2');
    }
    if (command === 'import') result = { valid: !failures.includes('mv2-import') };
    if (command === 'export' && sub === 'trajectories') {
      if (failures.includes('hf-export')) process.exit(1);
      fs.mkdirSync(flag('--out'), { recursive: true });
    }
    console.log(JSON.stringify(result));
  `,
  );
  writeFileSync(
    join(root, 'bin/python3'),
    `#!${process.execPath}
    const fs = require('node:fs'), path = require('node:path');
    const failures = JSON.parse(fs.readFileSync(path.join(__dirname, 'failures.json')));
    process.exit(failures.includes('hf-load') || !fs.existsSync(process.argv.at(-1)) ? 1 : 0);
  `,
    { mode: 0o755 },
  );
  const report = join(root, 'report.json');
  const result = spawnSync('bash', [join(root, 'scripts/quarterly-exit-test-q2.sh')], {
    env: {
      PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      QUARTERLY_GATE_REPORT: report,
      MEMPHIS_API_TOKEN: 'synthetic-operator-token',
      MEMPHIS_VAULT_PEPPER: 'synthetic-operator-pepper',
      OPERATOR_HOME: root,
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    result,
    report: JSON.parse(readFileSync(report, 'utf8')) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; blockedBy?: string }>;
    },
  };
}

it('passes only when every Q2 criterion succeeds in an isolated environment', () => {
  const { result, report } = fixture();
  expect(result.status, result.stderr).toBe(0);
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(9);
});

it.each([
  'checkpoint-install',
  'active-checkpoint',
  'vault-query',
  'cascade-tier0',
  'mv2-export',
  'mv2-import',
  'hf-export',
  'hf-load',
])('fails the gate when %s is not ready', (id) => {
  const { result, report } = fixture([id]);
  expect(result.status).toBe(1);
  expect(report.checks.find((check) => check.id === id)?.ok).toBe(false);
});

it('requires the audit and reports downstream checks blocked by failed exports', () => {
  const { result, report } = fixture(['mv2-export', 'hf-export'], false);
  expect(result.status).toBe(1);
  expect(report.checks.find((check) => check.id === 'security-audit')?.ok).toBe(false);
  expect(report.checks.find((check) => check.id === 'mv2-import')?.blockedBy).toBe('mv2-export');
  expect(report.checks.find((check) => check.id === 'hf-load')?.blockedBy).toBe('hf-export');
});

it('reports a malformed doctor payload as a failed criterion', () => {
  const { result, report } = fixture(['bad-json']);
  expect(result.status).toBe(1);
  expect(report.checks.find((check) => check.id === 'cascade-tier0')?.ok).toBe(false);
});
