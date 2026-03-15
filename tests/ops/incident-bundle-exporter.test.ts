import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
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

async function runIncidentBundleExporter(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', 'ops:export-incident-bundle', '--', ...args], {
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

describe('incident bundle exporter', () => {
  it('exports startup status, audit tail, and guard drill output with redaction enabled by default', async () => {
    const dir = makeTempDir('memphis-incident-bundle-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'bundle.json');
    writeFileSync(
      auditPath,
      [
        JSON.stringify({
          ts: '2026-01-01T00:00:00.000Z',
          action: 'a1',
          status: 'allowed',
          authorization: 'Bearer audit-token-123',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:01.000Z',
          action: 'a2',
          status: 'blocked',
          openai_api_key: 'sk-0123456789abcdef',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await withStatusServer(
      {
        startup: {
          trustRoot: { enabled: true, valid: true },
          revocationCache: { enabled: true, stale: false },
          safeModeNetwork: { enabled: false, mode: 'disabled' },
        },
        auth: {
          apiKey: 'sk-0123456789abcdef',
          authorization: 'Bearer top-secret-token',
          publicNote: 'operator-visible',
        },
      },
      async (statusUrl) => {
        const result = await runIncidentBundleExporter([
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          outPath,
          '--audit-lines',
          '10',
        ]);
        expect(result.status).toBe(0);
        const emitted = JSON.parse(result.stdout) as { ok: boolean; output: string };
        expect(emitted.ok).toBe(true);
        expect(emitted.output).toBe(outPath);

        const bundle = JSON.parse(readFileSync(outPath, 'utf8')) as {
          schemaVersion: number;
          status: {
            ok: boolean;
            payload?: {
              startup?: { trustRoot?: { valid?: boolean } };
              auth?: { apiKey?: string; authorization?: string; publicNote?: string };
            };
          };
          securityAudit: {
            tailLines: Array<{ action?: string; authorization?: string; openai_api_key?: string }>;
          };
          drill: {
            ok: boolean;
            result?: { schemaVersion?: number; scenarios?: Array<{ name?: string }> };
          };
        };

        expect(bundle.schemaVersion).toBe(1);
        expect(bundle.status.ok).toBe(true);
        expect(bundle.status.payload?.startup?.trustRoot?.valid).toBe(true);
        expect(bundle.status.payload?.auth?.apiKey).toBe('[REDACTED]');
        expect(bundle.status.payload?.auth?.authorization).toBe('[REDACTED]');
        expect(bundle.status.payload?.auth?.publicNote).toBe('operator-visible');
        expect(bundle.securityAudit.tailLines.length).toBe(2);
        expect(bundle.securityAudit.tailLines[1]?.action).toBe('a2');
        expect(bundle.securityAudit.tailLines[0]?.authorization).toBe('[REDACTED]');
        expect(bundle.securityAudit.tailLines[1]?.openai_api_key).toBe('[REDACTED]');
        expect(bundle.drill.ok).toBe(true);
        expect(bundle.drill.result?.schemaVersion).toBe(1);
        expect(bundle.drill.result?.scenarios?.map((s) => s.name).sort()).toEqual([
          'revocation-stale',
          'trust-root-invalid-strict',
        ]);
      },
    );
  });

  it('optionally embeds latest cognitive report summaries from journal', async () => {
    const dir = makeTempDir('memphis-incident-bundle-cognitive-');
    const dataDir = path.join(dir, 'memphis-data');
    const journalPath = path.join(dataDir, 'chains', 'journal');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'bundle-with-cognitive.json');
    const manifestPath = path.join(dir, 'bundle-with-cognitive.manifest.json');
    mkdirSync(journalPath, { recursive: true });
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

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
    writeFileSync(
      path.join(journalPath, '000003.json'),
      JSON.stringify({
        index: 3,
        timestamp: '2026-01-01T00:00:03.000Z',
        hash: 'hash-3',
        data: {
          type: 'reflection_report',
          schemaVersion: 1,
          source: 'cli.reflect',
          report: { generatedAt: '2026-01-01T00:00:03.000Z', input: 'reflection input' },
        },
      }),
      'utf8',
    );
    writeFileSync(
      path.join(journalPath, '000004.json'),
      JSON.stringify({
        index: 4,
        data: { type: 'unrelated_block' },
      }),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter(
        [
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          outPath,
          '--manifest-out',
          manifestPath,
          '--include-cognitive-summaries',
          '--cognitive-report-limit',
          '2',
        ],
        { MEMPHIS_DATA_DIR: dataDir },
      );
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as {
        ok: boolean;
        manifest?: string | null;
        cognitiveReports?: {
          enabled?: boolean;
          journalPath?: string;
          limit?: number;
          count?: number;
          digestSha256?: string | null;
        };
      };
      expect(emitted.ok).toBe(true);
      expect(emitted.manifest).toBe(manifestPath);
      expect(emitted.cognitiveReports?.enabled).toBe(true);
      expect(emitted.cognitiveReports?.journalPath).toBe(journalPath);
      expect(emitted.cognitiveReports?.limit).toBe(2);
      expect(emitted.cognitiveReports?.count).toBe(2);
      expect(typeof emitted.cognitiveReports?.digestSha256).toBe('string');
    });

    const bundle = JSON.parse(readFileSync(outPath, 'utf8')) as {
      cognitiveReports?: {
        schemaVersion?: number;
        journalPath?: string;
        limit?: number;
        count?: number;
        reports?: Array<{
          index?: number | null;
          timestamp?: string | null;
          hash?: string | null;
          reportType?: string;
          dataType?: string;
          schemaVersion?: number | null;
          source?: string | null;
          generatedAt?: string | null;
          input?: string | null;
          path?: string;
        }>;
      };
    };
    expect(bundle.cognitiveReports?.schemaVersion).toBe(1);
    expect(bundle.cognitiveReports?.journalPath).toBe(journalPath);
    expect(bundle.cognitiveReports?.limit).toBe(2);
    expect(bundle.cognitiveReports?.count).toBe(2);
    expect(bundle.cognitiveReports?.reports?.map((report) => report.reportType)).toEqual([
      'reflection',
      'categorize',
    ]);
    expect(bundle.cognitiveReports?.reports?.map((report) => report.dataType)).toEqual([
      'reflection_report',
      'categorize_report',
    ]);
    expect(bundle.cognitiveReports?.reports?.[0]?.path).toBe(path.join(journalPath, '000003.json'));
    expect(bundle.cognitiveReports?.reports?.[1]?.path).toBe(path.join(journalPath, '000002.json'));

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      cognitiveReports?: {
        included?: boolean;
        count?: number;
        digestSha256?: string | null;
        schemaVersion?: number | null;
        limit?: number | null;
        journalPath?: string | null;
      };
    };
    expect(manifest.cognitiveReports?.included).toBe(true);
    expect(manifest.cognitiveReports?.count).toBe(2);
    expect(manifest.cognitiveReports?.schemaVersion).toBe(1);
    expect(manifest.cognitiveReports?.limit).toBe(2);
    expect(manifest.cognitiveReports?.journalPath).toBe(journalPath);
    const canonicalReports = JSON.stringify(
      (bundle.cognitiveReports?.reports ?? []).map((report) => ({
        index: report.index ?? null,
        timestamp: report.timestamp ?? null,
        hash: report.hash ?? null,
        reportType: report.reportType ?? null,
        dataType: report.dataType ?? null,
        schemaVersion: report.schemaVersion ?? null,
        source: report.source ?? null,
        generatedAt: report.generatedAt ?? null,
        input: report.input ?? null,
        path: report.path ?? null,
      })),
    );
    expect(manifest.cognitiveReports?.digestSha256).toBe(
      createHash('sha256').update(canonicalReports).digest('hex'),
    );
  });

  it('prunes old timestamped incident bundles and paired manifests using retention policy', async () => {
    const dir = makeTempDir('memphis-incident-bundle-retention-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const oldA = path.join(dir, 'incident-bundle-2026-01-01T00-00-00-000Z.json');
    const oldB = path.join(dir, 'incident-bundle-2026-01-02T00-00-00-000Z.json');
    const oldC = path.join(dir, 'incident-bundle-2026-01-03T00-00-00-000Z.json');
    writeFileSync(oldA, '{"schemaVersion":1}', 'utf8');
    writeFileSync(oldB, '{"schemaVersion":1}', 'utf8');
    writeFileSync(oldC, '{"schemaVersion":1}', 'utf8');
    writeFileSync(oldA.replace('.json', '.manifest.json'), '{"schemaVersion":1}', 'utf8');
    writeFileSync(oldB.replace('.json', '.manifest.json'), '{"schemaVersion":1}', 'utf8');
    writeFileSync(oldC.replace('.json', '.manifest.json'), '{"schemaVersion":1}', 'utf8');
    writeFileSync(
      `${oldA}.enc`,
      '{"schemaVersion":1,"format":"memphis.encrypted-blob.v1"}',
      'utf8',
    );
    writeFileSync(
      `${oldB}.enc`,
      '{"schemaVersion":1,"format":"memphis.encrypted-blob.v1"}',
      'utf8',
    );
    writeFileSync(
      `${oldC}.enc`,
      '{"schemaVersion":1,"format":"memphis.encrypted-blob.v1"}',
      'utf8',
    );
    writeFileSync(
      `${oldA.replace('.json', '.manifest.json')}.enc`,
      '{"schemaVersion":1,"format":"memphis.encrypted-blob.v1"}',
      'utf8',
    );
    writeFileSync(
      `${oldB.replace('.json', '.manifest.json')}.enc`,
      '{"schemaVersion":1,"format":"memphis.encrypted-blob.v1"}',
      'utf8',
    );
    writeFileSync(
      `${oldC.replace('.json', '.manifest.json')}.enc`,
      '{"schemaVersion":1,"format":"memphis.encrypted-blob.v1"}',
      'utf8',
    );

    const now = new Date();
    utimesSync(oldA, now, new Date(now.getTime() - 30_000));
    utimesSync(oldB, now, new Date(now.getTime() - 20_000));
    utimesSync(oldC, now, new Date(now.getTime() - 10_000));

    const outPath = path.join(dir, 'incident-bundle-current.json');
    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter([
        '--status-url',
        statusUrl,
        '--audit-path',
        auditPath,
        '--out',
        outPath,
        '--retention-count',
        '2',
        '--retention-days',
        '3650',
      ]);
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as { ok: boolean; prunedFiles: string[] };
      expect(emitted.ok).toBe(true);
      expect(emitted.prunedFiles.length).toBeGreaterThanOrEqual(2);
    });

    const remainingBundles = readdirSync(dir)
      .filter(
        (name) =>
          name.startsWith('incident-bundle-') &&
          name.endsWith('.json') &&
          !name.endsWith('.manifest.json'),
      )
      .sort();
    expect(remainingBundles).toEqual([
      'incident-bundle-2026-01-03T00-00-00-000Z.json',
      'incident-bundle-current.json',
    ]);
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    expect(existsSync(oldA.replace('.json', '.manifest.json'))).toBe(false);
    expect(existsSync(oldB.replace('.json', '.manifest.json'))).toBe(false);
    expect(existsSync(`${oldA}.enc`)).toBe(false);
    expect(existsSync(`${oldB}.enc`)).toBe(false);
    expect(existsSync(`${oldA.replace('.json', '.manifest.json')}.enc`)).toBe(false);
    expect(existsSync(`${oldB.replace('.json', '.manifest.json')}.enc`)).toBe(false);
    expect(existsSync(oldC)).toBe(true);
    expect(existsSync(oldC.replace('.json', '.manifest.json'))).toBe(true);
    expect(existsSync(`${oldC}.enc`)).toBe(true);
    expect(existsSync(`${oldC.replace('.json', '.manifest.json')}.enc`)).toBe(true);
  });

  it('can emit a signed manifest for incident bundle chain-of-custody', async () => {
    const dir = makeTempDir('memphis-incident-bundle-signature-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle-signed.json');
    const manifestPath = path.join(dir, 'incident-bundle-signed.manifest.json');
    const keyPath = path.join(dir, 'manifest-signing-key.pem');
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    writeFileSync(
      keyPath,
      pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter([
        '--status-url',
        statusUrl,
        '--audit-path',
        auditPath,
        '--out',
        bundlePath,
        '--manifest-out',
        manifestPath,
        '--signing-key-path',
        keyPath,
      ]);
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as { ok: boolean; manifest: string | null };
      expect(emitted.ok).toBe(true);
      expect(emitted.manifest).toBe(manifestPath);
    });

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      schemaVersion: number;
      signature?: {
        algorithm?: string;
        value?: string;
        payloadSha256?: string;
      };
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.signature?.algorithm).toBe('ed25519');
    expect(typeof manifest.signature?.value).toBe('string');
    expect(typeof manifest.signature?.payloadSha256).toBe('string');

    const signatureValue = manifest.signature?.value ?? '';
    const unsigned = { ...manifest };
    delete (unsigned as { signature?: unknown }).signature;
    const payload = JSON.stringify(unsigned);
    const signatureBytes = Buffer.from(signatureValue, 'base64');
    const verified = verify(null, Buffer.from(payload, 'utf8'), pair.publicKey, signatureBytes);
    expect(verified).toBe(true);
    expect(manifest.signature?.payloadSha256).toBe(
      createHash('sha256').update(payload).digest('hex'),
    );
  });

  it('can emit encrypted bundle + manifest companions for off-host transfer', async () => {
    const dir = makeTempDir('memphis-incident-bundle-encrypted-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle.json');
    const manifestPath = path.join(dir, 'incident-bundle.manifest.json');
    const bundleEncryptedPath = `${bundlePath}.enc`;
    const manifestEncryptedPath = `${manifestPath}.enc`;
    const passphrase = 'operator-transfer-passphrase';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter([
        '--status-url',
        statusUrl,
        '--audit-path',
        auditPath,
        '--out',
        bundlePath,
        '--manifest-out',
        manifestPath,
        '--encryption-passphrase',
        passphrase,
      ]);
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as {
        ok: boolean;
        policy?: { queueMode?: string; requireEncryptedArtifacts?: boolean };
        encryption?: {
          enabled: boolean;
          source?: string;
          encryptedBundle?: { path?: string };
          encryptedManifest?: { path?: string };
        };
      };
      expect(emitted.ok).toBe(true);
      expect(emitted.policy?.requireEncryptedArtifacts).toBe(false);
      expect(emitted.encryption?.enabled).toBe(true);
      expect(emitted.encryption?.source).toBe('arg');
      expect(emitted.encryption?.encryptedBundle?.path).toBe(bundleEncryptedPath);
      expect(emitted.encryption?.encryptedManifest?.path).toBe(manifestEncryptedPath);
    });

    expect(existsSync(bundlePath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(bundleEncryptedPath)).toBe(true);
    expect(existsSync(manifestEncryptedPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      encryptedArtifacts?: {
        bundle?: { path?: string; sha256?: string; bytes?: number };
        manifest?: { path?: string };
      };
    };
    expect(manifest.encryptedArtifacts?.bundle?.path).toBe(bundleEncryptedPath);
    expect(typeof manifest.encryptedArtifacts?.bundle?.sha256).toBe('string');
    expect(typeof manifest.encryptedArtifacts?.bundle?.bytes).toBe('number');
    expect(manifest.encryptedArtifacts?.manifest?.path).toBe(manifestEncryptedPath);

    const encryptedBundleBlob = JSON.parse(readFileSync(bundleEncryptedPath, 'utf8')) as {
      format?: string;
      algorithm?: string;
      kdf?: { name?: string };
      ciphertext?: string;
    };
    expect(encryptedBundleBlob.format).toBe('memphis.encrypted-blob.v1');
    expect(encryptedBundleBlob.algorithm).toBe('aes-256-gcm');
    expect(encryptedBundleBlob.kdf?.name).toBe('scrypt');
    expect(typeof encryptedBundleBlob.ciphertext).toBe('string');
    expect(encryptedBundleBlob.ciphertext).not.toContain('trustRoot');
  });

  it('enforces encrypted artifact policy when requireEncryptedArtifacts=true', async () => {
    const dir = makeTempDir('memphis-incident-bundle-policy-encryption-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'incident-bundle.json');
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter(
        ['--status-url', statusUrl, '--audit-path', auditPath, '--out', outPath],
        {
          MEMPHIS_QUEUE_MODE: 'financial',
          MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS: 'true',
        },
      );
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('encrypted artifacts are required by policy');
    });
  });

  it('supports env-injected signing key PEM and records key-id metadata', async () => {
    const dir = makeTempDir('memphis-incident-bundle-env-key-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const bundlePath = path.join(dir, 'incident-bundle-signed.json');
    const manifestPath = path.join(dir, 'incident-bundle-signed.manifest.json');
    const keyId = 'incident-key-v1';
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    const pair = generateKeyPairSync('ed25519');
    const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter(
        [
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          bundlePath,
          '--manifest-out',
          manifestPath,
        ],
        {
          MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM: privatePem,
          MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_ID: keyId,
        },
      );
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as {
        ok: boolean;
        manifest: string | null;
        signingKeySource: string | null;
        signingKeyId: string | null;
      };
      expect(emitted.ok).toBe(true);
      expect(emitted.manifest).toBe(manifestPath);
      expect(emitted.signingKeySource).toBe('env-pem');
      expect(emitted.signingKeyId).toBe(keyId);
    });

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      signature?: {
        keyId?: string;
        value?: string;
      };
    };
    expect(manifest.signature?.keyId).toBe(keyId);

    const signatureValue = manifest.signature?.value ?? '';
    const unsigned = { ...manifest };
    delete (unsigned as { signature?: unknown }).signature;
    const payload = JSON.stringify(unsigned);
    const signatureBytes = Buffer.from(signatureValue, 'base64');
    const verified = verify(null, Buffer.from(payload, 'utf8'), pair.publicKey, signatureBytes);
    expect(verified).toBe(true);
  });

  it('supports financial-strict export profile and fails closed without encryption passphrase', async () => {
    const dir = makeTempDir('memphis-incident-bundle-profile-financial-strict-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'incident-bundle.json');
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter([
        '--status-url',
        statusUrl,
        '--audit-path',
        auditPath,
        '--out',
        outPath,
        '--profile',
        'financial-strict',
      ]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('encrypted artifacts are required by policy');
    });
  });

  it('supports forensics-lite export profile with automatic manifest output', async () => {
    const dir = makeTempDir('memphis-incident-bundle-profile-forensics-lite-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'incident-bundle.json');
    const inferredManifestPath = path.join(dir, 'incident-bundle.manifest.json');
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter([
        '--status-url',
        statusUrl,
        '--audit-path',
        auditPath,
        '--out',
        outPath,
        '--profile',
        'forensics-lite',
      ]);
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as {
        ok: boolean;
        manifest: string | null;
        policy?: { profile?: string | null; manifestRequested?: boolean };
      };
      expect(emitted.ok).toBe(true);
      expect(emitted.manifest).toBe(inferredManifestPath);
      expect(emitted.policy?.profile).toBe('forensics-lite');
      expect(emitted.policy?.manifestRequested).toBe(true);
    });

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(inferredManifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(inferredManifestPath, 'utf8')) as {
      cognitiveReports?: { included?: boolean; count?: number; digestSha256?: string | null };
    };
    expect(manifest.cognitiveReports?.included).toBe(false);
    expect(manifest.cognitiveReports?.count).toBe(0);
    expect(manifest.cognitiveReports?.digestSha256).toBeNull();
  });

  it('supports strict-handoff export profile with automatic cognitive summaries', async () => {
    const dir = makeTempDir('memphis-incident-bundle-profile-strict-handoff-');
    const dataDir = path.join(dir, '.memphis-data');
    const journalPath = path.join(dataDir, 'chains', 'journal');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'incident-bundle.json');
    const inferredManifestPath = path.join(dir, 'incident-bundle.manifest.json');
    mkdirSync(journalPath, { recursive: true });
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');
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
          report: { generatedAt: '2026-01-01T00:00:01.000Z', input: 'strict handoff seed' },
        },
      }),
      'utf8',
    );

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter(
        [
          '--status-url',
          statusUrl,
          '--audit-path',
          auditPath,
          '--out',
          outPath,
          '--profile',
          'strict-handoff',
        ],
        { MEMPHIS_DATA_DIR: dataDir },
      );
      expect(result.status).toBe(0);
      const emitted = JSON.parse(result.stdout) as {
        ok: boolean;
        manifest: string | null;
        policy?: { profile?: string | null; manifestRequested?: boolean };
        cognitiveReports?: { enabled?: boolean; count?: number };
      };
      expect(emitted.ok).toBe(true);
      expect(emitted.manifest).toBe(inferredManifestPath);
      expect(emitted.policy?.profile).toBe('strict-handoff');
      expect(emitted.policy?.manifestRequested).toBe(true);
      expect(emitted.cognitiveReports?.enabled).toBe(true);
      expect(emitted.cognitiveReports?.count).toBeGreaterThanOrEqual(1);
    });

    const bundle = JSON.parse(readFileSync(outPath, 'utf8')) as {
      cognitiveReports?: { included?: boolean; count?: number };
    };
    expect(bundle.cognitiveReports?.count).toBeGreaterThanOrEqual(1);

    const manifest = JSON.parse(readFileSync(inferredManifestPath, 'utf8')) as {
      cognitiveReports?: { included?: boolean; count?: number; digestSha256?: string | null };
    };
    expect(manifest.cognitiveReports?.included).toBe(true);
    expect(manifest.cognitiveReports?.count).toBeGreaterThanOrEqual(1);
    expect(typeof manifest.cognitiveReports?.digestSha256).toBe('string');
  });

  it('prints profile help hints for operators and shell completion tooling', async () => {
    const result = await runIncidentBundleExporter(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: npm run -s ops:export-incident-bundle -- [options]');
    expect(result.stdout).toContain('--profile <name>');
    expect(result.stdout).toContain('financial-strict|forensics-lite|strict-handoff');
    expect(result.stdout).toContain('MEMPHIS_INCIDENT_BUNDLE_EXPORT_PROFILE');
    expect(result.stdout).toContain('MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS');
  });

  it('prints machine-readable profile completion hints', async () => {
    const result = await runIncidentBundleExporter(['--completion-hints']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      command: string;
      profiles: string[];
      profileFlag: string;
      profileEnv: string;
      policyEnvVars: string[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.command).toBe('ops:export-incident-bundle');
    expect(parsed.profileFlag).toBe('--profile');
    expect(parsed.profileEnv).toBe('MEMPHIS_INCIDENT_BUNDLE_EXPORT_PROFILE');
    expect(parsed.profiles).toEqual(['financial-strict', 'forensics-lite', 'strict-handoff']);
    expect(parsed.policyEnvVars).toContain('MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS');
  });

  it('fails on unsupported export profile names', async () => {
    const dir = makeTempDir('memphis-incident-bundle-profile-invalid-');
    const auditPath = path.join(dir, 'security-audit.jsonl');
    const outPath = path.join(dir, 'incident-bundle.json');
    writeFileSync(auditPath, `${JSON.stringify({ action: 'boot' })}\n`, 'utf8');

    await withStatusServer({ startup: { trustRoot: { valid: true } } }, async (statusUrl) => {
      const result = await runIncidentBundleExporter([
        '--status-url',
        statusUrl,
        '--audit-path',
        auditPath,
        '--out',
        outPath,
        '--profile',
        'invalid-profile',
      ]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('unsupported export profile');
    });
  });
});
