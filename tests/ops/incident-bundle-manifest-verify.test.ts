import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as signDetached } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const tempDirs: string[] = [];

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

async function withStatusServer<T>(
  payload: unknown,
  fn: (statusUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const statusUrl = `http://127.0.0.1:${port}/v1/ops/status`;
  try {
    return await fn(statusUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function runCommand(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function seedCognitiveReports(dataDir: string): void {
  const journalPath = path.join(dataDir, 'chains', 'journal');
  mkdirSync(journalPath, { recursive: true });
  writeFileSync(
    path.join(journalPath, '000001.json'),
    JSON.stringify({
      index: 1,
      timestamp: '2026-01-01T00:00:01.000Z',
      hash: 'hash-1',
      data: {
        type: 'insight_report',
        schemaVersion: 1,
        source: 'cli.insights',
        report: { generatedAt: '2026-01-01T00:00:01.000Z', input: 'insight input' },
      },
    }),
    'utf8',
  );
  writeFileSync(
    path.join(journalPath, '000002.json'),
    JSON.stringify({
      index: 2,
      timestamp: '2026-01-01T00:00:02.000Z',
      hash: 'hash-2',
      data: {
        type: 'categorize_report',
        schemaVersion: 1,
        source: 'cli.categorize',
        report: { generatedAt: '2026-01-01T00:00:02.000Z', input: 'categorize input' },
      },
    }),
    'utf8',
  );
}

describe('incident manifest verifier', () => {
  it('verifies signed manifest and bundle hash successfully', async () => {
    const dir = makeTempDir('memphis-incident-manifest-verify-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle-signed.json');
    const manifestPath = path.join(dir, 'incident-bundle-signed.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const verifyKeyPath = path.join(dir, 'signing-public.pem');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    const keyId = 'incident-signer-a';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      verifyKeyPath,
      pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-path',
        verifyKeyPath,
        '--require-signature',
        '--expected-key-id',
        keyId,
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);

    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: {
        schemaValid: boolean;
        bundleHashMatch: boolean;
        bundleSizeMatch: boolean;
        signaturePresent: boolean;
        signatureVerified: boolean;
        payloadHashMatch: boolean;
        keyFingerprintMatch: boolean;
        keyIdMatch: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.schemaValid).toBe(true);
    expect(parsed.checks.bundleHashMatch).toBe(true);
    expect(parsed.checks.bundleSizeMatch).toBe(true);
    expect(parsed.checks.signaturePresent).toBe(true);
    expect(parsed.checks.signatureVerified).toBe(true);
    expect(parsed.checks.payloadHashMatch).toBe(true);
    expect(parsed.checks.keyFingerprintMatch).toBe(true);
    expect(parsed.checks.keyIdMatch).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('verifies cognitive summary digest/count integrity when metadata is present', async () => {
    const dir = makeTempDir('memphis-incident-manifest-cognitive-happy-');
    const dataDir = path.join(dir, '.memphis-data');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: dataDir };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');
    seedCognitiveReports(dataDir);

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
          '--include-cognitive-summaries',
          '--cognitive-report-limit',
          '10',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      ['ops:verify-incident-manifest', '--', '--manifest-path', manifestPath, '--skip-chain-event'],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: {
        cognitiveSummaryMetadataPresent: boolean;
        cognitiveSummaryCountMatch: boolean;
        cognitiveSummaryDigestMatch: boolean;
        cognitiveSummaryRequirementSatisfied: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.cognitiveSummaryMetadataPresent).toBe(true);
    expect(parsed.checks.cognitiveSummaryCountMatch).toBe(true);
    expect(parsed.checks.cognitiveSummaryDigestMatch).toBe(true);
    expect(parsed.checks.cognitiveSummaryRequirementSatisfied).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('passes strict cognitive-summary requirement when metadata is present', async () => {
    const dir = makeTempDir('memphis-incident-manifest-cognitive-strict-pass-');
    const dataDir = path.join(dir, '.memphis-data');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: dataDir };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');
    seedCognitiveReports(dataDir);

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
          '--include-cognitive-summaries',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--require-cognitive-summaries',
        '--skip-chain-event',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      policy: { requireCognitiveSummaries: boolean };
      checks: {
        cognitiveSummaryMetadataPresent: boolean;
        cognitiveSummaryCountMatch: boolean;
        cognitiveSummaryDigestMatch: boolean;
        cognitiveSummaryRequirementSatisfied: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.policy.requireCognitiveSummaries).toBe(true);
    expect(parsed.checks.cognitiveSummaryMetadataPresent).toBe(true);
    expect(parsed.checks.cognitiveSummaryCountMatch).toBe(true);
    expect(parsed.checks.cognitiveSummaryDigestMatch).toBe(true);
    expect(parsed.checks.cognitiveSummaryRequirementSatisfied).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('fails strict cognitive-summary requirement when metadata is missing', async () => {
    const dir = makeTempDir('memphis-incident-manifest-cognitive-strict-metadata-missing-');
    const dataDir = path.join(dir, '.memphis-data');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: dataDir };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--require-cognitive-summaries',
        '--skip-chain-event',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      policy: { requireCognitiveSummaries: boolean };
      checks: {
        cognitiveSummaryMetadataPresent: boolean;
        cognitiveSummaryCountMatch: boolean;
        cognitiveSummaryDigestMatch: boolean;
        cognitiveSummaryRequirementSatisfied: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.policy.requireCognitiveSummaries).toBe(true);
    expect(parsed.checks.cognitiveSummaryMetadataPresent).toBe(true);
    expect(parsed.checks.cognitiveSummaryCountMatch).toBe(false);
    expect(parsed.checks.cognitiveSummaryDigestMatch).toBe(false);
    expect(parsed.checks.cognitiveSummaryRequirementSatisfied).toBe(false);
    expect(
      parsed.errors.some((item) => item.includes('manifest.cognitiveReports.included=false')),
    ).toBe(true);
  });

  it('fails strict cognitive-summary requirement when bundle payload is missing', async () => {
    const dir = makeTempDir('memphis-incident-manifest-cognitive-strict-bundle-missing-');
    const dataDir = path.join(dir, '.memphis-data');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: dataDir };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');
    seedCognitiveReports(dataDir);

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
          '--include-cognitive-summaries',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as { cognitiveReports?: unknown };
    delete bundle.cognitiveReports;
    const tamperedBundle = JSON.stringify(bundle, null, 2);
    writeFileSync(bundlePath, tamperedBundle, 'utf8');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bundle: { sha256: string; bytes: number };
    };
    manifest.bundle.sha256 = sha256Hex(tamperedBundle);
    manifest.bundle.bytes = Buffer.byteLength(tamperedBundle, 'utf8');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--require-cognitive-summaries',
        '--skip-chain-event',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: {
        bundleHashMatch: boolean;
        bundleSizeMatch: boolean;
        cognitiveSummaryMetadataPresent: boolean;
        cognitiveSummaryCountMatch: boolean;
        cognitiveSummaryDigestMatch: boolean;
        cognitiveSummaryRequirementSatisfied: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.bundleHashMatch).toBe(true);
    expect(parsed.checks.bundleSizeMatch).toBe(true);
    expect(parsed.checks.cognitiveSummaryMetadataPresent).toBe(true);
    expect(parsed.checks.cognitiveSummaryCountMatch).toBe(false);
    expect(parsed.checks.cognitiveSummaryDigestMatch).toBe(false);
    expect(parsed.checks.cognitiveSummaryRequirementSatisfied).toBe(false);
    expect(
      parsed.errors.some((item) =>
        item.includes('bundle payload is missing cognitiveReports.reports'),
      ),
    ).toBe(true);
  });

  it('fails when bundle cognitive summaries are tampered after export', async () => {
    const dir = makeTempDir('memphis-incident-manifest-cognitive-bundle-tamper-');
    const dataDir = path.join(dir, '.memphis-data');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: dataDir };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');
    seedCognitiveReports(dataDir);

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
          '--include-cognitive-summaries',
          '--cognitive-report-limit',
          '10',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      cognitiveReports?: { reports?: Array<{ input?: string | null }> };
    };
    if (bundle.cognitiveReports?.reports?.[0]) {
      bundle.cognitiveReports.reports[0].input = 'tampered-input';
    }
    const tamperedBundle = JSON.stringify(bundle, null, 2);
    writeFileSync(bundlePath, tamperedBundle, 'utf8');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bundle: { sha256: string; bytes: number };
    };
    manifest.bundle.sha256 = sha256Hex(tamperedBundle);
    manifest.bundle.bytes = Buffer.byteLength(tamperedBundle, 'utf8');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const verifyResult = await runCommand(
      ['ops:verify-incident-manifest', '--', '--manifest-path', manifestPath, '--skip-chain-event'],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: {
        bundleHashMatch: boolean;
        bundleSizeMatch: boolean;
        cognitiveSummaryDigestMatch: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.bundleHashMatch).toBe(true);
    expect(parsed.checks.bundleSizeMatch).toBe(true);
    expect(parsed.checks.cognitiveSummaryDigestMatch).toBe(false);
    expect(parsed.errors.some((item) => item.includes('cognitive summary digest mismatch'))).toBe(
      true,
    );
  });

  it('fails when manifest cognitive summary count/digest metadata is tampered', async () => {
    const dir = makeTempDir('memphis-incident-manifest-cognitive-manifest-tamper-');
    const dataDir = path.join(dir, '.memphis-data');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: dataDir };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');
    seedCognitiveReports(dataDir);

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
          '--include-cognitive-summaries',
          '--cognitive-report-limit',
          '10',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      cognitiveReports?: { count?: number; digestSha256?: string | null };
    };
    if (manifest.cognitiveReports) {
      manifest.cognitiveReports.count = (manifest.cognitiveReports.count ?? 0) + 1;
      manifest.cognitiveReports.digestSha256 = '0'.repeat(64);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const verifyResult = await runCommand(
      ['ops:verify-incident-manifest', '--', '--manifest-path', manifestPath, '--skip-chain-event'],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: { cognitiveSummaryCountMatch: boolean; cognitiveSummaryDigestMatch: boolean };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.cognitiveSummaryCountMatch).toBe(false);
    expect(parsed.checks.cognitiveSummaryDigestMatch).toBe(false);
    expect(parsed.errors.some((item) => item.includes('cognitive summary count mismatch'))).toBe(
      true,
    );
    expect(parsed.errors.some((item) => item.includes('cognitive summary digest mismatch'))).toBe(
      true,
    );
  });

  it('writes immutable system chain event for manifest verification results', async () => {
    const dir = makeTempDir('memphis-incident-manifest-chain-event-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const verifyKeyPath = path.join(dir, 'signing-public.pem');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      verifyKeyPath,
      pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-path',
        verifyKeyPath,
        '--require-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      chainEvent?: { attempted?: boolean; written?: boolean; index?: number; hash?: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.chainEvent?.attempted).toBe(true);
    expect(parsed.chainEvent?.written).toBe(true);
    expect(typeof parsed.chainEvent?.index).toBe('number');
    expect(typeof parsed.chainEvent?.hash).toBe('string');

    const chainDir = path.join(commandEnv.MEMPHIS_DATA_DIR, 'chains', 'system');
    expect(existsSync(chainDir)).toBe(true);
    const files = readdirSync(chainDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const last = JSON.parse(readFileSync(path.join(chainDir, files.at(-1) ?? ''), 'utf8')) as {
      data?: {
        type?: string;
        event?: string;
        payload?: { ok?: boolean; manifestPath?: string; bundlePath?: string };
      };
    };
    expect(last.data?.type).toBe('system_event');
    expect(last.data?.event).toBe('incident_manifest.verification');
    expect(last.data?.payload?.ok).toBe(true);
    expect(last.data?.payload?.manifestPath).toBe(manifestPath);
    expect(last.data?.payload?.bundlePath).toContain('incident-bundle.json');
  });

  it('retries chain-event append and fails closed when chain linkage is required', async () => {
    const dir = makeTempDir('memphis-incident-manifest-chain-retry-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const verifyKeyPath = path.join(dir, 'signing-public.pem');
    const exportEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      verifyKeyPath,
      pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        exportEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const blockedDataPath = path.join(dir, 'blocked-data-dir');
    writeFileSync(blockedDataPath, 'not-a-directory', 'utf8');
    const verifyEnv = {
      MEMPHIS_DATA_DIR: blockedDataPath,
      MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED: 'true',
    };

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-path',
        verifyKeyPath,
        '--require-signature',
        '--chain-event-retry-count',
        '2',
        '--chain-event-retry-backoff-ms',
        '1',
      ],
      verifyEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      chainEvent?: { attempted?: boolean; written?: boolean; attempts?: number; error?: string };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.chainEvent?.attempted).toBe(true);
    expect(parsed.chainEvent?.written).toBe(false);
    expect(parsed.chainEvent?.attempts).toBe(3);
    expect(typeof parsed.chainEvent?.error).toBe('string');
    expect(
      parsed.errors.some((item) =>
        item.includes('failed to append incident verification chain event'),
      ),
    ).toBe(true);
  });

  it('fails verification when bundle content is tampered after manifest export', async () => {
    const dir = makeTempDir('memphis-incident-manifest-tamper-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const original = readFileSync(bundlePath, 'utf8');
    writeFileSync(bundlePath, `${original}\n`, 'utf8');

    const verifyResult = await runCommand(
      ['ops:verify-incident-manifest', '--', '--manifest-path', manifestPath],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);

    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: {
        bundleHashMatch: boolean;
        bundleSizeMatch: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.bundleHashMatch).toBe(false);
    expect(parsed.checks.bundleSizeMatch).toBe(false);
    expect(parsed.errors.some((item) => item.includes('bundle sha256 mismatch'))).toBe(true);
  });

  it('fails when signature is required but manifest is unsigned', async () => {
    const dir = makeTempDir('memphis-incident-manifest-require-signature-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--require-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);

    const parsed = JSON.parse(verifyResult.stdout) as { ok: boolean; errors: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((item) => item.includes('signature is required'))).toBe(true);
  });

  it('fails when expected key id does not match manifest signature metadata', async () => {
    const dir = makeTempDir('memphis-incident-manifest-key-id-mismatch-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const verifyKeyPath = path.join(dir, 'signing-public.pem');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      verifyKeyPath,
      pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
          'actual-key',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-path',
        verifyKeyPath,
        '--require-signature',
        '--expected-key-id',
        'expected-key',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);

    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: { keyIdMatch: boolean };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.keyIdMatch).toBe(false);
    expect(parsed.errors.some((item) => item.includes('signature key id mismatch'))).toBe(true);
  });

  it('verifies signed manifest via detached public-key bundle lookup', async () => {
    const dir = makeTempDir('memphis-incident-manifest-key-bundle-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const publicKeyBundlePath = path.join(dir, 'public-key-bundle.json');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    const keyId = 'bundle-key-1';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      publicKeyBundlePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          keys: [{ keyId, publicKeyPem }],
        },
        null,
        2,
      ),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-bundle-path',
        publicKeyBundlePath,
        '--expected-key-id',
        keyId,
        '--require-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);

    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: { signatureVerified: boolean; keyFingerprintMatch: boolean; keyIdMatch: boolean };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.signatureVerified).toBe(true);
    expect(parsed.checks.keyFingerprintMatch).toBe(true);
    expect(parsed.checks.keyIdMatch).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('verifies detached key bundle provenance against trust root manifest', async () => {
    const dir = makeTempDir('memphis-incident-manifest-key-bundle-provenance-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const publicKeyBundlePath = path.join(dir, 'public-key-bundle.json');
    const trustRootPath = path.join(dir, 'trust_root.json');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    const keyId = 'bundle-key-provenance';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

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
            signedAt: '2026-03-12T00:00:00.000Z',
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

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-bundle-path',
        publicKeyBundlePath,
        '--trust-root-path',
        trustRootPath,
        '--expected-key-id',
        keyId,
        '--require-signature',
        '--require-key-bundle-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);

    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: { keyBundleSignatureValid: boolean; keyBundleTrustRootMatch: boolean };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.keyBundleSignatureValid).toBe(true);
    expect(parsed.checks.keyBundleTrustRootMatch).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('fails detached key bundle provenance when signature is tampered', async () => {
    const dir = makeTempDir('memphis-incident-manifest-key-bundle-provenance-tamper-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const publicKeyBundlePath = path.join(dir, 'public-key-bundle.json');
    const trustRootPath = path.join(dir, 'trust_root.json');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    const keyId = 'bundle-key-provenance-tampered';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

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
    const tamperedSignature = provenanceSignature.slice(0, -2) + 'ab';

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
            signature: tamperedSignature,
            signedAt: '2026-03-12T00:00:00.000Z',
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

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-bundle-path',
        publicKeyBundlePath,
        '--trust-root-path',
        trustRootPath,
        '--expected-key-id',
        keyId,
        '--require-signature',
        '--require-key-bundle-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: { keyBundleSignatureValid: boolean; keyBundleTrustRootMatch: boolean };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.keyBundleSignatureValid).toBe(false);
    expect(parsed.checks.keyBundleTrustRootMatch).toBe(true);
    expect(
      parsed.errors.some((item) =>
        item.includes('public key bundle signature verification failed'),
      ),
    ).toBe(true);
  });

  it('fails detached public-key bundle lookup when key id is missing', async () => {
    const dir = makeTempDir('memphis-incident-manifest-key-bundle-missing-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const publicKeyBundlePath = path.join(dir, 'public-key-bundle.json');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      publicKeyBundlePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          keys: [{ keyId: 'some-other-key', publicKeyPem }],
        },
        null,
        2,
      ),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
          'expected-key',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-bundle-path',
        publicKeyBundlePath,
        '--expected-key-id',
        'expected-key',
        '--require-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as { ok: boolean; errors: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((item) => item.includes('public key bundle missing keyId'))).toBe(
      true,
    );
  });

  it('verifies encrypted manifest + bundle companions with decryption passphrase', async () => {
    const dir = makeTempDir('memphis-incident-manifest-encrypted-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const encryptedManifestPath = `${manifestPath}.enc`;
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const verifyKeyPath = path.join(dir, 'signing-public.pem');
    const keyId = 'encrypted-key-v1';
    const passphrase = 'incident-transfer-passphrase';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      verifyKeyPath,
      pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
          '--encryption-passphrase',
          passphrase,
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        encryptedManifestPath,
        '--decryption-passphrase',
        passphrase,
        '--public-key-path',
        verifyKeyPath,
        '--expected-key-id',
        keyId,
        '--require-signature',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(0);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      checks: {
        manifestEncrypted: boolean;
        bundleEncrypted: boolean;
        signatureVerified: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.manifestEncrypted).toBe(true);
    expect(parsed.checks.bundleEncrypted).toBe(true);
    expect(parsed.checks.signatureVerified).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('fails encrypted manifest verification when decryption passphrase is missing', async () => {
    const dir = makeTempDir('memphis-incident-manifest-encrypted-no-passphrase-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const encryptedManifestPath = `${manifestPath}.enc`;
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
          '--encryption-passphrase',
          'missing-passphrase-test',
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      ['ops:verify-incident-manifest', '--', '--manifest-path', encryptedManifestPath],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as { ok: boolean; errors: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((item) => item.includes('manifest is encrypted'))).toBe(true);
  });

  it('supports trust-root-strict verify profile and enforces detached key-bundle provenance', async () => {
    const dir = makeTempDir('memphis-incident-manifest-profile-trust-root-strict-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const signingKeyPath = path.join(dir, 'signing-private.pem');
    const verifyKeyPath = path.join(dir, 'signing-public.pem');
    const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      signingKeyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      verifyKeyPath,
      pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
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
        ],
        commandEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--public-key-path',
        verifyKeyPath,
        '--profile',
        'trust-root-strict',
      ],
      commandEnv,
    );
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      policy: {
        profile: string | null;
        requireSignature: boolean;
        requireSignedKeyBundle: boolean;
        requireCognitiveSummaries: boolean;
      };
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.policy.profile).toBe('trust-root-strict');
    expect(parsed.policy.requireSignature).toBe(true);
    expect(parsed.policy.requireSignedKeyBundle).toBe(true);
    expect(parsed.policy.requireCognitiveSummaries).toBe(true);
    expect(
      parsed.errors.some((item) =>
        item.includes('require-key-bundle-signature requires --public-key-bundle-path'),
      ),
    ).toBe(true);
  });

  it('supports legacy-compat verify profile with non-blocking chain-link failures', async () => {
    const dir = makeTempDir('memphis-incident-manifest-profile-legacy-compat-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const exportEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const exportResult = await runCommand(
        [
          'ops:export-incident-bundle',
          '--',
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
        ],
        exportEnv,
      );
      expect(exportResult.status).toBe(0);
    });

    const blockedDataPath = path.join(dir, 'blocked-data-dir');
    writeFileSync(blockedDataPath, 'not-a-directory', 'utf8');
    const verifyEnv = { MEMPHIS_DATA_DIR: blockedDataPath };
    const verifyResult = await runCommand(
      [
        'ops:verify-incident-manifest',
        '--',
        '--manifest-path',
        manifestPath,
        '--profile',
        'legacy-compat',
      ],
      verifyEnv,
    );
    expect(verifyResult.status).toBe(0);
    const parsed = JSON.parse(verifyResult.stdout) as {
      ok: boolean;
      policy: {
        profile: string | null;
        requireSignature: boolean;
        requireSignedKeyBundle: boolean;
        requireCognitiveSummaries: boolean;
        requireChainEvent: boolean;
      };
      chainEvent?: { written?: boolean };
      errors: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.policy.profile).toBe('legacy-compat');
    expect(parsed.policy.requireSignature).toBe(false);
    expect(parsed.policy.requireSignedKeyBundle).toBe(false);
    expect(parsed.policy.requireCognitiveSummaries).toBe(false);
    expect(parsed.policy.requireChainEvent).toBe(false);
    expect(parsed.chainEvent?.written).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  it('prints profile help hints for operators and shell completion tooling', async () => {
    const verifyResult = await runCommand(['ops:verify-incident-manifest', '--', '--help']);
    expect(verifyResult.status).toBe(0);
    expect(verifyResult.stdout).toContain(
      'Usage: npm run -s ops:verify-incident-manifest -- [options]',
    );
    expect(verifyResult.stdout).toContain('--profile <name>');
    expect(verifyResult.stdout).toContain('--require-cognitive-summaries');
    expect(verifyResult.stdout).toContain('trust-root-strict|legacy-compat');
    expect(verifyResult.stdout).toContain('MEMPHIS_INCIDENT_MANIFEST_VERIFY_PROFILE');
    expect(verifyResult.stdout).toContain('MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED');
    expect(verifyResult.stdout).toContain('MEMPHIS_INCIDENT_REQUIRE_COGNITIVE_SUMMARIES');
  });

  it('prints machine-readable verify profile completion hints', async () => {
    const verifyResult = await runCommand([
      'ops:verify-incident-manifest',
      '--',
      '--completion-hints',
    ]);
    expect(verifyResult.status).toBe(0);
    const parsed = JSON.parse(verifyResult.stdout) as {
      schemaVersion: number;
      command: string;
      profiles: string[];
      profileFlag: string;
      profileEnv: string;
      policyEnvVars: string[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.command).toBe('ops:verify-incident-manifest');
    expect(parsed.profileFlag).toBe('--profile');
    expect(parsed.profileEnv).toBe('MEMPHIS_INCIDENT_MANIFEST_VERIFY_PROFILE');
    expect(parsed.profiles).toEqual(['trust-root-strict', 'legacy-compat']);
    expect(parsed.policyEnvVars).toContain('MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED');
    expect(parsed.policyEnvVars).toContain('MEMPHIS_INCIDENT_REQUIRE_COGNITIVE_SUMMARIES');
  });

  it('fails on unsupported verify profile names', async () => {
    const dir = makeTempDir('memphis-incident-manifest-profile-invalid-');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-03-12T00:00:00.000Z',
        bundle: { path: 'missing.json', sha256: 'deadbeef', bytes: 0 },
      }),
      'utf8',
    );

    const verifyResult = await runCommand([
      'ops:verify-incident-manifest',
      '--',
      '--manifest-path',
      manifestPath,
      '--profile',
      'invalid-profile',
    ]);
    expect(verifyResult.status).toBe(1);
    const parsed = JSON.parse(verifyResult.stderr) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('unsupported verify profile');
  });
});
