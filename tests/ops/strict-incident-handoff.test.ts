import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as signDetached } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const tempDirs: string[] = [];
const contractFixturePath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'output-contract.json',
);
const preflightFailureFixturePath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'failure-preflight.json',
);
const exportFailureFixturePath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'failure-export.json',
);
const verifyFailureFixturePath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'failure-verify.json',
);

type OutputContractFixture = {
  schemaVersion: number;
  summaryTopLevelKeys: string[];
  summaryProfileKeys: string[];
  summaryArtifactKeys: string[];
  summaryCheckKeys: string[];
  validStages: string[];
  completionHintTopLevelKeys: string[];
  completionHintProfileKeys: string[];
};

type FailureContractFixture = {
  stage: 'preflight' | 'export' | 'verify';
  ok: boolean;
  errorContains: string;
  errorsContain?: string[];
  errorsContainAny?: string[];
};

const outputContract = JSON.parse(
  readFileSync(contractFixturePath, 'utf8'),
) as OutputContractFixture;
const preflightFailureContract = JSON.parse(
  readFileSync(preflightFailureFixturePath, 'utf8'),
) as FailureContractFixture;
const exportFailureContract = JSON.parse(
  readFileSync(exportFailureFixturePath, 'utf8'),
) as FailureContractFixture;
const verifyFailureContract = JSON.parse(
  readFileSync(verifyFailureFixturePath, 'utf8'),
) as FailureContractFixture;

interface HandoffSummary {
  schemaVersion: number;
  ok: boolean;
  stage: 'preflight' | 'export' | 'verify';
  profiles: { export: string; verify: string };
  artifacts: { bundlePath: string | null; manifestPath: string | null };
  checks: {
    signatureVerified: boolean | null;
    keyBundleSignatureValid: boolean | null;
    keyBundleTrustRootMatch: boolean | null;
    cognitiveSummaryRequirementSatisfied: boolean | null;
    schedulerWorkerPostureSafe: boolean | null;
    chainEventWritten: boolean | null;
    chainEventIndex: number | null;
    chainEventHash: string | null;
  };
  error: string | null;
  errors: string[];
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function withStatusServer<T>(
  payload: unknown,
  fn: (statusUrl: string) => Promise<T>,
): Promise<T> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
const { createServer } = require('node:http');
const payload = JSON.parse(process.env.MEMPHIS_STATUS_PAYLOAD || '{}');
const server = createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.stdout.write(String(port));
});
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
      `,
    ],
    {
      env: {
        ...process.env,
        MEMPHIS_STATUS_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const port = await new Promise<number>((resolve, reject) => {
    const stderr: Buffer[] = [];
    const onError = (error: Error) => reject(error);
    child.once('error', onError);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.stdout?.once('data', (chunk: Buffer) => {
      child.off('error', onError);
      const raw = chunk.toString('utf8').trim();
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        reject(
          new Error(
            `failed to start status server: ${raw || Buffer.concat(stderr).toString('utf8').trim() || 'empty output'}`,
          ),
        );
        return;
      }
      resolve(parsed);
    });
  });
  const statusUrl = `http://127.0.0.1:${port}/v1/ops/status`;
  try {
    return await fn(statusUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', (error) => reject(error));
      child.kill('SIGTERM');
    });
  }
}

function runStrictHandoff(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('npm', ['run', '-s', 'ops:strict-incident-handoff', '--', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
    timeout: 30_000,
  });
}

function writeStrictKeyFixtures(
  dir: string,
  keyId: string,
): {
  signingKeyPath: string;
  publicKeyBundlePath: string;
  trustRootPath: string;
} {
  const signingKeyPath = path.join(dir, 'incident-signing-private.pem');
  const publicKeyBundlePath = path.join(dir, 'public-key-bundle.json');
  const trustRootPath = path.join(dir, 'trust_root.json');

  const manifestPair = generateKeyPairSync('ed25519');
  writeFileSync(
    signingKeyPath,
    manifestPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    'utf8',
  );
  const bundlePublicKeyPem = manifestPair.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();

  const trustRootSigner = generateKeyPairSync('ed25519');
  const signerPublicKeyPem = trustRootSigner.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const signerRootId = sha256Hex(signerPublicKeyPem);
  const unsignedBundle = {
    schemaVersion: 1,
    keys: [{ keyId, publicKeyPem: bundlePublicKeyPem }],
  };
  const unsignedPayload = JSON.stringify(unsignedBundle);
  const provenanceSignature = signDetached(
    null,
    Buffer.from(unsignedPayload, 'utf8'),
    trustRootSigner.privateKey,
  ).toString('base64');

  writeFileSync(
    publicKeyBundlePath,
    JSON.stringify(
      {
        ...unsignedBundle,
        provenance: {
          algorithm: 'ed25519',
          signerRootId,
          signerPublicKeyPem,
          payloadSha256: sha256Hex(unsignedPayload),
          signature: provenanceSignature,
          signedAt: '2026-03-13T00:00:00.000Z',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    trustRootPath,
    JSON.stringify({ version: 1, rootIds: [signerRootId] }, null, 2),
    'utf8',
  );

  return { signingKeyPath, publicKeyBundlePath, trustRootPath };
}

function expectSummaryContract(summary: HandoffSummary): void {
  expect(summary.schemaVersion).toBe(outputContract.schemaVersion);
  expect(outputContract.validStages.includes(summary.stage)).toBe(true);
  expect(Object.keys(summary).sort()).toEqual([...outputContract.summaryTopLevelKeys].sort());
  expect(Object.keys(summary.profiles).sort()).toEqual(
    [...outputContract.summaryProfileKeys].sort(),
  );
  expect(Object.keys(summary.artifacts).sort()).toEqual(
    [...outputContract.summaryArtifactKeys].sort(),
  );
  expect(Object.keys(summary.checks).sort()).toEqual([...outputContract.summaryCheckKeys].sort());
}

function expectFailureContract(summary: HandoffSummary, contract: FailureContractFixture): void {
  expectSummaryContract(summary);
  expect(summary.ok).toBe(contract.ok);
  expect(summary.stage).toBe(contract.stage);
  expect(summary.error ?? '').toContain(contract.errorContains);
  if (Array.isArray(contract.errorsContain) && contract.errorsContain.length > 0) {
    for (const expected of contract.errorsContain) {
      expect(summary.errors.some((entry) => entry.includes(expected))).toBe(true);
    }
  }
  if (Array.isArray(contract.errorsContainAny) && contract.errorsContainAny.length > 0) {
    expect(
      contract.errorsContainAny.some((expected) =>
        summary.errors.some((entry) => entry.includes(expected)),
      ),
    ).toBe(true);
  }
}

describe('strict incident handoff script', () => {
  it('prints help hints for operators and shell completion tooling', () => {
    const result = runStrictHandoff(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: npm run -s ops:strict-incident-handoff -- [options]');
    expect(result.stdout).toContain('--completion-hints');
    expect(result.stdout).toContain('MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH');
    expect(result.stdout).toContain('MEMPHIS_TRUST_ROOT_PATH');
  });

  it('prints machine-readable completion hints', () => {
    const result = runStrictHandoff(['--completion-hints']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      command: string;
      profiles: { export: string; verify: string };
      requiredFlags: string[];
      requiredSigningKeyFlags: string[];
      optionalValueFlags: string[];
      optionalBooleanFlags: string[];
      policyEnvVars: string[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(Object.keys(parsed).sort()).toEqual(
      [...outputContract.completionHintTopLevelKeys].sort(),
    );
    expect(Object.keys(parsed.profiles).sort()).toEqual(
      [...outputContract.completionHintProfileKeys].sort(),
    );
    expect(parsed.command).toBe('ops:strict-incident-handoff');
    expect(parsed.profiles).toEqual({ export: 'strict-handoff', verify: 'trust-root-strict' });
    expect(parsed.requiredFlags).toContain('--public-key-bundle-path');
    expect(parsed.optionalBooleanFlags).toContain('--json');
    expect(parsed.optionalBooleanFlags).toContain('--preflight-only');
    expect(parsed.optionalBooleanFlags).toContain('--completion-hints');
    expect(parsed.policyEnvVars).toContain('MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH');
  });

  it('supports preflight-only mode for readiness checks without export/verify', () => {
    const dir = makeTempDir('memphis-strict-handoff-preflight-only-');
    const keyId = 'strict-preflight-only-key-v1';
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const { signingKeyPath, publicKeyBundlePath, trustRootPath } = writeStrictKeyFixtures(
      dir,
      keyId,
    );

    const result = runStrictHandoff([
      '--preflight-only',
      '--out',
      bundlePath,
      '--signing-key-path',
      signingKeyPath,
      '--signing-key-id',
      keyId,
      '--public-key-bundle-path',
      publicKeyBundlePath,
      '--trust-root-path',
      trustRootPath,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as HandoffSummary;
    expectSummaryContract(parsed);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('preflight');
    expect(parsed.artifacts.bundlePath).toBeNull();
    expect(parsed.artifacts.manifestPath).toBeNull();
    expect(parsed.errors).toEqual([]);
    expect(existsSync(bundlePath)).toBe(false);
  });

  it('prints human-readable preflight pass summary for operator smoke checks', () => {
    const dir = makeTempDir('memphis-strict-handoff-preflight-human-');
    const keyId = 'strict-preflight-human-key-v1';
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const { signingKeyPath, publicKeyBundlePath, trustRootPath } = writeStrictKeyFixtures(
      dir,
      keyId,
    );

    const result = runStrictHandoff([
      '--preflight-only',
      '--out',
      bundlePath,
      '--signing-key-path',
      signingKeyPath,
      '--signing-key-id',
      keyId,
      '--public-key-bundle-path',
      publicKeyBundlePath,
      '--trust-root-path',
      trustRootPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] strict incident handoff preflight checks passed');
    expect(existsSync(bundlePath)).toBe(false);
  });

  it(
    'runs strict export+verify flow and returns pass summary in json mode',
    { timeout: 30_000 },
    async () => {
      const dir = makeTempDir('memphis-strict-handoff-success-');
      const keyId = 'strict-handoff-key-v1';
      const auditPath = path.join(dir, 'security-audit.jsonl');
      const bundlePath = path.join(dir, 'incident-bundle.json');
      const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
      const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
      writeFileSync(auditPath, `${JSON.stringify({ action: 'startup.ok' })}\n`, 'utf8');
      const { signingKeyPath, publicKeyBundlePath, trustRootPath } = writeStrictKeyFixtures(
        dir,
        keyId,
      );

      await withStatusServer(
        {
          startup: { trustRoot: { valid: true } },
          scheduler: { configuredTarget: 'workers', effectiveTarget: 'workers' },
        },
        async (statusUrl) => {
          const result = runStrictHandoff(
            [
              '--status-url',
              statusUrl,
              '--audit-path',
              auditPath,
              '--out',
              bundlePath,
              '--manifest-out',
              manifestPath,
              '--signing-key-path',
              signingKeyPath,
              '--signing-key-id',
              keyId,
              '--public-key-bundle-path',
              publicKeyBundlePath,
              '--trust-root-path',
              trustRootPath,
              '--json',
            ],
            commandEnv,
          );
          expect(result.status).toBe(0);

          const parsed = JSON.parse(result.stdout) as HandoffSummary;
          expectSummaryContract(parsed);
          expect(parsed.ok).toBe(true);
          expect(parsed.stage).toBe('verify');
          expect(parsed.artifacts.bundlePath).toBe(bundlePath);
          expect(parsed.artifacts.manifestPath).toBe(manifestPath);
          expect(parsed.checks.signatureVerified).toBe(true);
          expect(parsed.checks.keyBundleSignatureValid).toBe(true);
          expect(parsed.checks.keyBundleTrustRootMatch).toBe(true);
          expect(parsed.checks.cognitiveSummaryRequirementSatisfied).toBe(true);
          expect(parsed.checks.schedulerWorkerPostureSafe).toBe(true);
          expect(parsed.checks.chainEventWritten).toBe(true);
          expect(parsed.error).toBeNull();
          expect(parsed.errors).toEqual([]);
        },
      );
    },
  );

  it('fails preflight when public key bundle is missing', () => {
    const dir = makeTempDir('memphis-strict-handoff-preflight-');
    const keyId = 'strict-preflight-key-v1';
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const { signingKeyPath, trustRootPath } = writeStrictKeyFixtures(dir, keyId);
    writeFileSync(auditPath, `${JSON.stringify({ action: 'startup.ok' })}\n`, 'utf8');

    const result = runStrictHandoff([
      '--audit-path',
      auditPath,
      '--signing-key-path',
      signingKeyPath,
      '--signing-key-id',
      keyId,
      '--trust-root-path',
      trustRootPath,
      '--json',
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as HandoffSummary;
    expectFailureContract(parsed, preflightFailureContract);
  });

  it(
    'fails export stage when encrypted artifacts are required without passphrase',
    { timeout: 30_000 },
    async () => {
      const dir = makeTempDir('memphis-strict-handoff-export-fail-');
      const keyId = 'strict-export-key-v1';
      const auditPath = path.join(dir, 'security-audit.jsonl');
      const bundlePath = path.join(dir, 'incident-bundle.json');
      const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
      writeFileSync(auditPath, `${JSON.stringify({ action: 'startup.ok' })}\n`, 'utf8');
      const { signingKeyPath, publicKeyBundlePath, trustRootPath } = writeStrictKeyFixtures(
        dir,
        keyId,
      );

      await withStatusServer(
        {
          startup: { trustRoot: { valid: true } },
          scheduler: { configuredTarget: 'workers', effectiveTarget: 'workers' },
        },
        async (statusUrl) => {
          const result = runStrictHandoff(
            [
              '--status-url',
              statusUrl,
              '--audit-path',
              auditPath,
              '--out',
              bundlePath,
              '--require-encrypted-artifacts',
              '--signing-key-path',
              signingKeyPath,
              '--signing-key-id',
              keyId,
              '--public-key-bundle-path',
              publicKeyBundlePath,
              '--trust-root-path',
              trustRootPath,
              '--json',
            ],
            commandEnv,
          );
          expect(result.status).toBe(1);
          const parsed = JSON.parse(result.stdout) as HandoffSummary;
          expectFailureContract(parsed, exportFailureContract);
        },
      );
    },
  );

  it(
    'fails verify stage when expected key id does not match signer key id',
    { timeout: 30_000 },
    async () => {
      const dir = makeTempDir('memphis-strict-handoff-verify-fail-');
      const keyId = 'strict-verify-key-v1';
      const auditPath = path.join(dir, 'security-audit.jsonl');
      const bundlePath = path.join(dir, 'incident-bundle.json');
      const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
      const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
      writeFileSync(auditPath, `${JSON.stringify({ action: 'startup.ok' })}\n`, 'utf8');
      const { signingKeyPath, publicKeyBundlePath, trustRootPath } = writeStrictKeyFixtures(
        dir,
        keyId,
      );

      await withStatusServer(
        {
          startup: { trustRoot: { valid: true } },
          scheduler: { configuredTarget: 'workers', effectiveTarget: 'workers' },
        },
        async (statusUrl) => {
          const result = runStrictHandoff(
            [
              '--status-url',
              statusUrl,
              '--audit-path',
              auditPath,
              '--out',
              bundlePath,
              '--manifest-out',
              manifestPath,
              '--signing-key-path',
              signingKeyPath,
              '--signing-key-id',
              keyId,
              '--expected-key-id',
              'wrong-key-id',
              '--public-key-bundle-path',
              publicKeyBundlePath,
              '--trust-root-path',
              trustRootPath,
              '--json',
            ],
            commandEnv,
          );
          expect(result.status).toBe(1);
          const parsed = JSON.parse(result.stdout) as HandoffSummary;
          expectFailureContract(parsed, verifyFailureContract);
        },
      );
    },
  );

  it('fails preflight when status-url reports scheduler worker fallback', async () => {
    const dir = makeTempDir('memphis-strict-handoff-scheduler-fallback-');
    const keyId = 'strict-scheduler-fallback-key-v1';
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const { signingKeyPath, publicKeyBundlePath, trustRootPath } = writeStrictKeyFixtures(
      dir,
      keyId,
    );

    await withStatusServer(
      {
        startup: { trustRoot: { valid: true } },
        scheduler: {
          configuredTarget: 'workers',
          effectiveTarget: 'local',
          fallbackReason: 'worker session tokens are not ready; using local execution',
        },
      },
      async (statusUrl) => {
        const result = runStrictHandoff([
          '--preflight-only',
          '--status-url',
          statusUrl,
          '--out',
          bundlePath,
          '--signing-key-path',
          signingKeyPath,
          '--signing-key-id',
          keyId,
          '--public-key-bundle-path',
          publicKeyBundlePath,
          '--trust-root-path',
          trustRootPath,
          '--json',
        ]);

        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout) as HandoffSummary;
        expectSummaryContract(parsed);
        expect(parsed.ok).toBe(false);
        expect(parsed.stage).toBe('preflight');
        expect(parsed.checks.schedulerWorkerPostureSafe).toBe(false);
        expect(parsed.error).toBe('strict handoff preflight failed');
        expect(
          parsed.errors.some((entry) =>
            entry.includes('strict handoff status reports scheduler worker fallback'),
          ),
        ).toBe(true);
      },
    );
  });
});
