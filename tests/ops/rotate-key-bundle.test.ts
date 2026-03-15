import { spawn } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify as verifyDetached } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../scripts/lib/encrypted-blob.mts';

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

async function runRotateKeyBundle(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', 'ops:rotate-key-bundle', '--', ...args], {
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

describe('key bundle rotation tooling', () => {
  it('generates a rotated bundle with signed provenance from trusted root', async () => {
    const dir = makeTempDir('memphis-key-bundle-rotate-');
    const baseBundlePath = path.join(dir, 'public-key-bundle.base.json');
    const bundleOutPath = path.join(dir, 'public-key-bundle.rotated.json');
    const trustRootPath = path.join(dir, 'trust_root.json');
    const trustRootSignerPath = path.join(dir, 'trust-root-signer.pem');
    const newPrivateKeyOutPath = path.join(dir, 'incident-signing-v2.pem');
    const newPublicKeyOutPath = path.join(dir, 'incident-signing-v2.pub.pem');
    const existingKeyId = 'incident-key-v1';
    const newKeyId = 'incident-key-v2';

    const trustRootSigner = generateKeyPairSync('ed25519');
    const trustRootSignerPublicPem = trustRootSigner.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const signerRootId = sha256Hex(trustRootSignerPublicPem);
    writeFileSync(
      trustRootSignerPath,
      trustRootSigner.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      trustRootPath,
      JSON.stringify(
        {
          version: 9,
          rootIds: [signerRootId],
        },
        null,
        2,
      ),
      'utf8',
    );

    const existingPair = generateKeyPairSync('ed25519');
    writeFileSync(
      baseBundlePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          keys: [
            {
              keyId: existingKeyId,
              publicKeyPem: existingPair.publicKey
                .export({ format: 'pem', type: 'spki' })
                .toString(),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await runRotateKeyBundle([
      '--trust-root-path',
      trustRootPath,
      '--trust-root-signing-key-path',
      trustRootSignerPath,
      '--base-bundle-path',
      baseBundlePath,
      '--bundle-out',
      bundleOutPath,
      '--new-key-id',
      newKeyId,
      '--new-private-key-out',
      newPrivateKeyOutPath,
      '--new-public-key-out',
      newPublicKeyOutPath,
    ]);

    expect(result.status).toBe(0);

    const emitted = JSON.parse(result.stdout) as {
      ok: boolean;
      keyId: string;
      keyCount: number;
      signerRootId: string;
    };
    expect(emitted.ok).toBe(true);
    expect(emitted.keyId).toBe(newKeyId);
    expect(emitted.keyCount).toBe(2);
    expect(emitted.signerRootId).toBe(signerRootId);

    expect(existsSync(bundleOutPath)).toBe(true);
    expect(existsSync(newPrivateKeyOutPath)).toBe(true);
    expect(existsSync(newPublicKeyOutPath)).toBe(true);

    const outputBundle = JSON.parse(readFileSync(bundleOutPath, 'utf8')) as {
      schemaVersion: number;
      keys: Array<{ keyId: string; publicKeyPem: string }>;
      provenance: {
        algorithm: string;
        signerRootId: string;
        signerPublicKeyPem: string;
        payloadSha256: string;
        signature: string;
      };
    };
    expect(outputBundle.schemaVersion).toBe(1);
    expect(outputBundle.keys.map((entry) => entry.keyId)).toEqual([existingKeyId, newKeyId]);
    expect(outputBundle.provenance.algorithm).toBe('ed25519');
    expect(outputBundle.provenance.signerRootId).toBe(signerRootId);
    expect(outputBundle.provenance.signerPublicKeyPem).toBe(trustRootSignerPublicPem);

    const newPublicKeyPem = readFileSync(newPublicKeyOutPath, 'utf8');
    const newPrivateKeyPem = readFileSync(newPrivateKeyOutPath, 'utf8');
    const derivedPublicFromPrivate = createPublicKey(newPrivateKeyPem)
      .export({ format: 'pem', type: 'spki' })
      .toString();
    expect(derivedPublicFromPrivate).toBe(newPublicKeyPem);
    expect(outputBundle.keys.find((entry) => entry.keyId === newKeyId)?.publicKeyPem).toBe(
      newPublicKeyPem,
    );

    const unsignedPayload = JSON.stringify({
      schemaVersion: outputBundle.schemaVersion,
      keys: outputBundle.keys,
    });
    expect(outputBundle.provenance.payloadSha256).toBe(sha256Hex(unsignedPayload));
    const signatureValid = verifyDetached(
      null,
      Buffer.from(unsignedPayload, 'utf8'),
      trustRootSigner.publicKey,
      Buffer.from(outputBundle.provenance.signature, 'base64'),
    );
    expect(signatureValid).toBe(true);
  });

  it('fails closed when trust root signer is not present in trust root manifest', async () => {
    const dir = makeTempDir('memphis-key-bundle-rotate-untrusted-');
    const trustRootPath = path.join(dir, 'trust_root.json');
    const trustRootSignerPath = path.join(dir, 'trust-root-signer.pem');
    const bundleOutPath = path.join(dir, 'public-key-bundle.rotated.json');
    const newPrivateKeyOutPath = path.join(dir, 'incident-signing-v2.pem');
    const newPublicKeyOutPath = path.join(dir, 'incident-signing-v2.pub.pem');

    const trustRootSigner = generateKeyPairSync('ed25519');
    writeFileSync(
      trustRootSignerPath,
      trustRootSigner.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );

    const otherTrustRoot = generateKeyPairSync('ed25519');
    const otherRootId = sha256Hex(
      otherTrustRoot.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    );
    writeFileSync(
      trustRootPath,
      JSON.stringify(
        {
          version: 4,
          rootIds: [otherRootId],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await runRotateKeyBundle([
      '--trust-root-path',
      trustRootPath,
      '--trust-root-signing-key-path',
      trustRootSignerPath,
      '--bundle-out',
      bundleOutPath,
      '--new-key-id',
      'incident-key-v2',
      '--new-private-key-out',
      newPrivateKeyOutPath,
      '--new-public-key-out',
      newPublicKeyOutPath,
    ]);

    expect(result.status).toBe(1);
    const emitted = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(emitted.ok).toBe(false);
    expect(emitted.error).toContain('trust root signer is not in active trust root set');
    expect(existsSync(bundleOutPath)).toBe(false);
    expect(existsSync(newPrivateKeyOutPath)).toBe(false);
    expect(existsSync(newPublicKeyOutPath)).toBe(false);
  });

  it('fails when new key id already exists in the base bundle', async () => {
    const dir = makeTempDir('memphis-key-bundle-rotate-duplicate-key-id-');
    const baseBundlePath = path.join(dir, 'public-key-bundle.base.json');
    const bundleOutPath = path.join(dir, 'public-key-bundle.rotated.json');
    const trustRootPath = path.join(dir, 'trust_root.json');
    const trustRootSignerPath = path.join(dir, 'trust-root-signer.pem');
    const duplicateKeyId = 'incident-key-v1';

    const trustRootSigner = generateKeyPairSync('ed25519');
    const trustRootSignerPublicPem = trustRootSigner.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const signerRootId = sha256Hex(trustRootSignerPublicPem);
    writeFileSync(
      trustRootSignerPath,
      trustRootSigner.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'utf8',
    );
    writeFileSync(
      trustRootPath,
      JSON.stringify(
        {
          version: 5,
          rootIds: [signerRootId],
        },
        null,
        2,
      ),
      'utf8',
    );

    const existingPair = generateKeyPairSync('ed25519');
    writeFileSync(
      baseBundlePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          keys: [
            {
              keyId: duplicateKeyId,
              publicKeyPem: existingPair.publicKey
                .export({ format: 'pem', type: 'spki' })
                .toString(),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await runRotateKeyBundle([
      '--trust-root-path',
      trustRootPath,
      '--trust-root-signing-key-path',
      trustRootSignerPath,
      '--base-bundle-path',
      baseBundlePath,
      '--bundle-out',
      bundleOutPath,
      '--new-key-id',
      duplicateKeyId,
    ]);

    expect(result.status).toBe(1);
    const emitted = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(emitted.ok).toBe(false);
    expect(emitted.error).toContain(`new key id already exists in bundle: ${duplicateKeyId}`);
    expect(existsSync(bundleOutPath)).toBe(false);
  });
});
