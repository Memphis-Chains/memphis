import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'memphis-q2-exit-'));
const data = join(work, 'data');
mkdirSync(data, { mode: 0o700 });
writeFileSync(join(work, '.env'), '', { mode: 0o600 });
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: '@memphis-chains/memphis' }));

// A literal allowlist keeps operator credentials, paths and force flags out of
// the acceptance runtime. Application APIs own any writes inside this fixture.
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: work,
  LANG: 'C.UTF-8',
  TMPDIR: work,
  TMP: work,
  TEMP: work,
  MEMPHIS_RUNTIME_ROOT: work,
  MEMPHIS_ENV_FILE: join(work, '.env'),
  MEMPHIS_HOME: data,
  MEMPHIS_DATA_DIR: data,
  MEMPHIS_VAULT_STATE_PATH: join(data, 'vault-state.json'),
  MEMPHIS_VAULT_ENTRIES_PATH: join(data, 'vault-entries.json'),
  DATABASE_URL: `file:${join(data, 'memphis.db')}`,
  RUST_CHAIN_ENABLED: 'true',
  RUST_CHAIN_BRIDGE_PATH: join(root, 'crates/memphis-napi/index.node'),
  MEMPHIS_KARTOGRAF_ENABLE: 'true',
  // Generated in memory for this throwaway vault; never inherits the operator pepper.
  MEMPHIS_VAULT_PEPPER: randomBytes(32).toString('hex'),
};
const checks = [];
function command(args) {
  return spawnSync(process.execPath, [join(root, 'bin/memphis.js'), ...args, '--json'], {
    cwd: work,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
function probe(
  id,
  description,
  args,
  accept = (s) => s != null && s.ok !== false,
  allowedExits = [0],
) {
  const result = command(args);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    /* invalid output fails JSON-dependent checks */
  }
  let ok = false;
  try {
    ok = allowedExits.includes(result.status) && accept(payload);
  } catch {
    /* malformed payload fails closed */
  }
  checks.push({
    id,
    description,
    ok,
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
  });
  return ok;
}
const audit = join(root, 'docs/security/AUDIT-2026-Q2.md');
checks.push({
  id: 'security-audit',
  description: 'Nonempty Q2 security audit report',
  ok: existsSync(audit) && statSync(audit).isFile() && statSync(audit).size > 0,
});
probe('checkpoint-install', 'Install the signed Q2 release as the active checkpoint', [
  'kartograf',
  'install',
  '--source',
  'github-release',
  '--release-tag',
  'v1.7.0',
  '--force-active',
]);
probe(
  'active-checkpoint',
  'An active checkpoint is reported',
  ['kartograf', 'status'],
  (s) => s?.active_checkpoint != null,
);
probe(
  'vault-query',
  'Vault query has an embedding and confidence above 0.5',
  ['kartograf', 'query', 'vault pepper rotation'],
  (s) =>
    Array.isArray(s?.embedding) &&
    s.embedding.length > 0 &&
    s.embedding.every(Number.isFinite) &&
    s.topZone === 'vault' &&
    s.confidence > 0.5,
);
probe(
  'cascade-tier0',
  'Doctor confirms Kartograf is the tier-0 embedding provider',
  ['doctor'],
  (s) =>
    s?.checks?.some(
      (c) => (c.name ?? c.id) === 'embed_cascade_tier0' && c.provider === 'kartograf',
    ) === true,
  [0, 1],
);

const fixture = spawnSync(process.execPath, [join(root, 'scripts/quarterly-mv2-fixture.mjs')], {
  cwd: work,
  env,
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 1024 * 1024,
});
const mv2 = join(work, 'quarter.mv2');
const exported = probe(
  'mv2-export',
  'Export all six Q2 chains',
  [
    'export',
    '--format=mv2',
    '--output',
    mv2,
    '--include',
    'journal,decisions,reflections,cases,patterns,system',
  ],
  (s) =>
    fixture.status === 0 &&
    s?.blockCount >= 6 &&
    existsSync(mv2) &&
    statSync(mv2).isFile() &&
    statSync(mv2).size > 0,
);
if (exported) {
  probe(
    'mv2-import',
    'Dry-run import validates the exported container',
    ['import', '--from-mv2', mv2, '--into', join(work, 'imported'), '--dry-run'],
    (s) => s?.valid === true,
  );
} else {
  checks.push({
    id: 'mv2-import',
    description: 'Dry-run import validates the exported container',
    ok: false,
    blockedBy: 'mv2-export',
  });
}
const dataset = join(work, 'trajectories');
const trajectoryExport = probe('hf-export', 'Export trajectories in HF dataset format', [
  'export',
  'trajectories',
  '--out',
  dataset,
  '--format=hf-dataset',
]);
if (trajectoryExport) {
  const loaded = spawnSync(
    'python3',
    [
      '-c',
      'import sys; from datasets import load_dataset; d = load_dataset(sys.argv[1]); assert len(d["train"]) > 0; assert "events_json" in d["train"].column_names',
      dataset,
    ],
    {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  checks.push({
    id: 'hf-load',
    description: 'Hugging Face datasets loads the exported dataset',
    ok: loaded.status === 0,
    exitCode: loaded.status,
    diagnostic:
      loaded.status === 0
        ? undefined
        : (loaded.stderr || loaded.error?.message || 'Loader failed').slice(-4000),
  });
} else {
  checks.push({
    id: 'hf-load',
    description: 'Hugging Face datasets loads the exported dataset',
    ok: false,
    blockedBy: 'hf-export',
  });
}
const report = {
  quarter: 'q2',
  ok: checks.every((c) => c.ok),
  checks,
  // Retain the isolated fixture for failure investigation. Hosted runners
  // dispose of it with the job; local operators can inspect it before cleanup.
  workDir: work,
  operatorEnvironmentInherited: false,
};
const output = process.env.QUARTERLY_GATE_REPORT ?? join(work, 'report.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
for (const check of checks)
  console.log(`[${check.ok ? 'pass' : 'fail'}] ${check.id}: ${check.description}`);
console.log(`Q2 exit test: ${report.ok ? 'PASS' : 'FAIL'}; report=${output}`);
process.exitCode = report.ok ? 0 : 1;
