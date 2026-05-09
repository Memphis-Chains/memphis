import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateVaultPepper } from '../../src/infra/cli/utils/onboarding-shared.js';
import { rotateVaultStatePepper } from '../../src/infra/storage/rust-vault-adapter.js';

function deriveKek(pepper: string): Buffer {
  return scryptSync(pepper, 'memphis-vault-state-v2', 32, {
    N: 16384,
    r: 8,
    p: 1,
  }) as Buffer;
}

function wrapState(masterKey: Buffer, salt: Buffer, pepper: string): string {
  const kek = deriveKek(pepper);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify(
    {
      version: 2,
      salt: salt.toString('base64'),
      encryptedMasterKey: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    },
    null,
    2,
  );
}

function unwrapState(path: string, pepper: string): Buffer {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    version: 2;
    salt: string;
    encryptedMasterKey: string;
    iv: string;
    tag: string;
  };
  const kek = deriveKek(pepper);
  const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.encryptedMasterKey, 'base64')),
    decipher.final(),
  ]);
}

function setupFixture(): { statePath: string; masterKey: Buffer; oldPepper: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-pepper-rotate-'));
  const statePath = join(dir, 'vault-state.json');
  const oldPepper = 'old-pepper-more-than-twelve-chars';
  const masterKey = randomBytes(32);
  const salt = randomBytes(16);
  writeFileSync(statePath, wrapState(masterKey, salt, oldPepper));
  return { statePath, masterKey, oldPepper };
}

describe('rotateVaultStatePepper', () => {
  it('rewraps the master key under a new pepper; old pepper no longer decrypts', () => {
    const { statePath, masterKey, oldPepper } = setupFixture();
    const newPepper = 'new-pepper-also-more-than-twelve';

    const result = rotateVaultStatePepper(oldPepper, newPepper, {
      MEMPHIS_VAULT_STATE_PATH: statePath,
    } as NodeJS.ProcessEnv);

    expect(result.fromVersion).toBe(2);
    expect(result.toVersion).toBe(2);

    const recoveredUnderNew = unwrapState(statePath, newPepper);
    expect(recoveredUnderNew.equals(masterKey)).toBe(true);

    expect(() => unwrapState(statePath, oldPepper)).toThrow();
  });

  it('refuses when new pepper is shorter than 12 chars', () => {
    const { statePath, oldPepper } = setupFixture();
    expect(() =>
      rotateVaultStatePepper(oldPepper, 'short', {
        MEMPHIS_VAULT_STATE_PATH: statePath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/at least 12/i);
  });

  it('refuses when new pepper equals old pepper', () => {
    const { statePath, oldPepper } = setupFixture();
    expect(() =>
      rotateVaultStatePepper(oldPepper, oldPepper, {
        MEMPHIS_VAULT_STATE_PATH: statePath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/must differ/i);
  });

  it('refuses when old pepper is wrong', () => {
    const { statePath } = setupFixture();
    expect(() =>
      rotateVaultStatePepper('wrong-old-pepper-padding', 'fresh-new-pepper-more-than-twelve', {
        MEMPHIS_VAULT_STATE_PATH: statePath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/decrypt vault state/i);
  });

  it('refuses when state file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-pepper-rotate-missing-'));
    const statePath = join(dir, 'vault-state.json');
    expect(() =>
      rotateVaultStatePepper('any-old-pepper-padding', 'any-new-pepper-more-than-twelve', {
        MEMPHIS_VAULT_STATE_PATH: statePath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/not found/i);
  });
});

// `vault pepper-rotate --generate` mints the new pepper via this helper
// rather than prompting for one. The handler is interactive-only, so the
// flag-path itself is exercised via the live CLI; here we pin the
// invariants the handler relies on so that flag is safe to ship.
describe('generateVaultPepper (the --generate source)', () => {
  it('produces a value that satisfies the pepper-rotate min-length check (>= 12)', () => {
    const value = generateVaultPepper();
    expect(value.length).toBeGreaterThanOrEqual(12);
  });

  it('produces the documented `memphis-<32 hex>` shape (40 chars, 128 bits of entropy)', () => {
    const value = generateVaultPepper();
    expect(value).toMatch(/^memphis-[0-9a-f]{32}$/);
    expect(value).toHaveLength(40);
  });

  it('produces a fresh value on every call (RNG actually engaged)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateVaultPepper());
    }
    expect(seen.size).toBe(50);
  });

  it('end-to-end: generated pepper rewraps the master key + old pepper no longer decrypts', () => {
    const { statePath, masterKey, oldPepper } = setupFixture();
    const newPepper = generateVaultPepper();

    rotateVaultStatePepper(oldPepper, newPepper, {
      MEMPHIS_VAULT_STATE_PATH: statePath,
    } as NodeJS.ProcessEnv);

    const recoveredUnderNew = unwrapState(statePath, newPepper);
    expect(recoveredUnderNew.equals(masterKey)).toBe(true);
    expect(() => unwrapState(statePath, oldPepper)).toThrow();
  });
});
