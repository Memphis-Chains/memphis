import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { VaultEntryError, VaultStateError } from '../../src/infra/storage/rust-vault-adapter.js';

const {
  writeSecurityAudit,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
  getLatestVaultEntry,
  listVaultEntries,
  saveVaultEntry,
  verifyVaultEntry,
} = vi.hoisted(() => ({
  writeSecurityAudit: vi.fn(),
  vaultDecrypt: vi.fn(),
  vaultEncrypt: vi.fn(),
  vaultInit: vi.fn(),
  getLatestVaultEntry: vi.fn(),
  listVaultEntries: vi.fn(),
  saveVaultEntry: vi.fn(),
  verifyVaultEntry: vi.fn(),
}));

vi.mock('../../src/infra/logging/security-audit.js', () => ({
  writeSecurityAudit,
}));

vi.mock('../../src/infra/storage/rust-vault-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infra/storage/rust-vault-adapter.js')>()),
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
}));

vi.mock('../../src/infra/storage/vault-entry-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infra/storage/vault-entry-store.js')>()),
  readLatestVaultSecret: (key: string, env: NodeJS.ProcessEnv) => {
    const entry = getLatestVaultEntry(key, env);
    if (!entry) return undefined;
    if (!verifyVaultEntry(entry)) throw new VaultEntryError('VAULT_ENTRY_INTEGRITY_FAILED');
    return { entry, plaintext: vaultDecrypt(entry, env) };
  },
  getLatestVaultEntry,
  listVaultEntries,
  saveVaultEntry,
  verifyVaultEntry,
}));

describe('vault boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns generic decrypt errors and keeps audit metadata safe', async () => {
    const { readVaultSecretByKey } = await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue({
      id: 'entry-1',
      key: 'SHARED_LLM_API_KEY',
      createdAt: '2026-03-26T12:00:00.000Z',
      fingerprint: 'fp-1',
    });
    verifyVaultEntry.mockReturnValue(true);
    vaultDecrypt.mockImplementation(() => {
      throw new Error('decrypt failed with sensitive debug context');
    });

    const result = readVaultSecretByKey('SHARED_LLM_API_KEY', {
      surface: 'cli',
      command: 'vault get',
    });

    expect(result.error).toBe('Vault entry decryption failed');
    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.secret-read',
        status: 'error',
        details: expect.objectContaining({
          surface: 'cli',
          command: 'vault get',
          reason: 'vault_decrypt_failed',
        }),
      }),
    );
    expect(writeSecurityAudit.mock.calls[0][0].details).not.toHaveProperty('plaintext');
    expect(writeSecurityAudit.mock.calls[0][0].details).not.toHaveProperty('message');
  });

  it('drops secret-derived hashes and nested error details from audit', async () => {
    const { auditVaultOperation } = await import('../../src/security/vault-boundary.js');
    auditVaultOperation({ surface: 'mcp' }, 'bounded-use', 'error', {
      key: 'test-reference',
      reason: 'vault_decrypt_failed',
      plaintextHash: 'synthetic-hash',
      causeMessage: 'synthetic-secret',
      nested: { value: 'synthetic-secret' },
    });
    const serialized = JSON.stringify(writeSecurityAudit.mock.calls);
    expect(serialized).not.toContain('synthetic-secret');
    expect(serialized).not.toContain('synthetic-hash');
    expect(serialized).toContain('vault_decrypt_failed');
  });

  it('projects audit fields by meaning instead of accepting arbitrary primitive strings', async () => {
    const { auditVaultOperation } = await import('../../src/security/vault-boundary.js');
    const sentinel = 'synthetic-private-audit-value';
    auditVaultOperation({ surface: 'mcp' }, 'bounded-use', 'error', {
      key: 'test-reference',
      reason: sentinel,
      source: sentinel,
      probe: sentinel,
      count: sentinel,
      found: sentinel,
      version: sentinel,
      did: sentinel,
    });
    expect(JSON.stringify(writeSecurityAudit.mock.calls)).not.toContain(sentinel);
    expect(writeSecurityAudit.mock.calls[0][0].details).toMatchObject({
      key: 'test-reference',
      surface: 'mcp',
    });
  });

  it('retains a valid audit IP and rejects arbitrary forwarded-header text', async () => {
    const { auditVaultOperation } = await import('../../src/security/vault-boundary.js');
    const sentinel = 'synthetic-private-header-value';
    auditVaultOperation({ surface: 'http', ip: sentinel }, 'bounded-use', 'error', {
      reason: 'vault_decrypt_failed',
    });
    auditVaultOperation({ surface: 'http', ip: '127.0.0.1' }, 'bounded-use', 'error', {
      reason: 'vault_decrypt_failed',
    });
    expect(JSON.stringify(writeSecurityAudit.mock.calls)).not.toContain(sentinel);
    expect(writeSecurityAudit.mock.calls[1][0].ip).toBe('127.0.0.1');
  });

  it('does not propagate an initialization exception, cause or nested credential text', async () => {
    const { initializeVault } = await import('../../src/security/vault-boundary.js');
    const sentinel = 'synthetic-private-initialization-value';
    listVaultEntries.mockReturnValue([]);
    vaultInit.mockImplementation(() => {
      throw new Error(sentinel, { cause: { headers: { Authorization: sentinel } } });
    });
    let failure: Error | undefined;
    try {
      initializeVault(
        { passphrase: sentinel, recovery_question: 'fixture?', recovery_answer: sentinel },
        { surface: 'http', route: '/v1/vault/init' },
      );
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('Vault initialization failed');
    expect(
      JSON.stringify({
        message: failure?.message,
        cause: failure?.cause,
        stack: failure?.stack,
        audit: writeSecurityAudit.mock.calls,
      }),
    ).not.toContain(sentinel);
  });

  it('retains safe initialization failure codes without copying exception details', async () => {
    const { initializeVault } = await import('../../src/security/vault-boundary.js');
    const sentinel = 'synthetic-private-typed-error-value';
    listVaultEntries.mockReturnValue([]);
    const stateError = new VaultStateError('VAULT_PEPPER_REQUIRED');
    stateError.message = sentinel;
    const bridgeError = new AppError(
      'BRIDGE_UNAVAILABLE',
      sentinel,
      503,
      { headers: sentinel },
      undefined,
      new Error(sentinel),
    );
    for (const original of [stateError, bridgeError]) {
      vaultInit.mockImplementation(() => {
        throw original;
      });
      let failure: (Error & { code?: string }) | undefined;
      try {
        initializeVault(
          { passphrase: 'synthetic', recovery_question: 'fixture?', recovery_answer: 'synthetic' },
          { surface: 'http', route: '/v1/vault/init' },
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.code).toBe(original.code);
      expect(
        JSON.stringify({
          message: failure?.message,
          cause: failure?.cause,
          audit: writeSecurityAudit.mock.calls,
        }),
      ).not.toContain(sentinel);
    }
  });

  it('lists metadata without decrypting plaintext', async () => {
    const { listVaultEntryMetadata } = await import('../../src/security/vault-boundary.js');

    listVaultEntries.mockReturnValue([
      {
        id: 'entry-1',
        key: 'OPENAI_API_KEY',
        createdAt: '2026-03-26T12:00:00.000Z',
        fingerprint: 'fp-1',
      },
    ]);
    verifyVaultEntry.mockReturnValue(true);

    const entries = listVaultEntryMetadata({ surface: 'http', route: '/v1/vault/entries' });

    expect(entries).toEqual([
      expect.objectContaining({
        key: 'OPENAI_API_KEY',
        fingerprint: 'fp-1',
        integrityOk: true,
      }),
    ]);
    expect(vaultDecrypt).not.toHaveBeenCalled();
  });

  it('audits bounded-use access without returning the plaintext', async () => {
    // 2026-10-09: this test used to be called "without exposing plaintext"
    // while asserting `plaintext: 'super-secret-token'` on the returned
    // object — it asserted the bug it was named after. The scoped helper
    // now hands the secret to a callback, so the contract is inverted: the
    // callback receives it, the return value never carries it.
    const { withVaultSecret } = await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue({
      id: 'entry-2',
      key: 'MEMPHIS_API_TOKEN',
      createdAt: '2026-03-26T12:00:00.000Z',
      fingerprint: 'fp-2',
    });
    verifyVaultEntry.mockReturnValue(true);
    vaultDecrypt.mockReturnValue('super-secret-token');

    let seenInsideCallback: string | undefined;
    const returned = withVaultSecret(
      'MEMPHIS_API_TOKEN',
      {
        surface: 'system',
        route: 'config:vault-resolve',
      },
      (plaintext) => {
        seenInsideCallback = plaintext;
        // The caller chooses what to return. Returning the raw secret is a
        // deliberate act of the caller, not a property of the helper.
        return { length: plaintext.length };
      },
    );

    expect(seenInsideCallback).toBe('super-secret-token');
    expect(returned).toEqual({ length: 'super-secret-token'.length });

    // The helper itself must not attach the secret to anything it returns
    // on its own behalf.
    const passthrough = withVaultSecret(
      'MEMPHIS_API_TOKEN',
      {
        surface: 'system',
        route: 'config:vault-resolve',
      },
      (plaintext) => plaintext,
    );
    expect(passthrough).toBe('super-secret-token');

    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.bounded-use',
        status: 'allowed',
        route: 'config:vault-resolve',
        details: expect.objectContaining({
          surface: 'system',
          key: 'MEMPHIS_API_TOKEN',
        }),
      }),
    );
    expect(writeSecurityAudit.mock.calls[0][0].details).not.toHaveProperty('plaintext');
  });

  it('raises without invoking the callback when the entry is missing', async () => {
    const { withVaultSecret, VaultSecretUnavailableError } =
      await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue(undefined);

    let called = false;
    expect(() =>
      withVaultSecret('MISSING_KEY', { surface: 'system', route: 'config:vault-resolve' }, () => {
        called = true;
      }),
    ).toThrow(VaultSecretUnavailableError);
    expect(called).toBe(false);
  });

  it('raises without invoking the callback when integrity verification fails', async () => {
    const { withVaultSecret, VaultSecretUnavailableError } =
      await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue({
      id: 'entry-3',
      key: 'TAMPERED',
      createdAt: '2026-03-26T12:00:00.000Z',
      fingerprint: 'fp-3',
    });
    verifyVaultEntry.mockReturnValue(false);

    let called = false;
    expect(() =>
      withVaultSecret('TAMPERED', { surface: 'system', route: 'config:vault-resolve' }, () => {
        called = true;
      }),
    ).toThrow(VaultSecretUnavailableError);
    expect(called).toBe(false);
    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.bounded-use',
        status: 'blocked',
      }),
    );
  });

  it('does not expose the secret when decryption throws', async () => {
    const { withVaultSecret, VaultSecretUnavailableError } =
      await import('../../src/security/vault-boundary.js');

    getLatestVaultEntry.mockReturnValue({
      id: 'entry-4',
      key: 'BROKEN',
      createdAt: '2026-03-26T12:00:00.000Z',
      fingerprint: 'fp-4',
    });
    verifyVaultEntry.mockReturnValue(true);
    vaultDecrypt.mockImplementation(() => {
      throw new Error('boom');
    });

    let called = false;
    expect(() =>
      withVaultSecret('BROKEN', { surface: 'system', route: 'config:vault-resolve' }, () => {
        called = true;
      }),
    ).toThrow(VaultSecretUnavailableError);
    expect(called).toBe(false);
  });

  it('probes vault cipher cycle through bounded-use audit path', async () => {
    const { probeVaultCipherCycle } = await import('../../src/security/vault-boundary.js');

    vaultEncrypt.mockReturnValue({
      key: '__vault_probe__',
      ciphertext: 'enc',
      nonce: 'n',
      tag: 't',
      createdAt: '2026-03-26T12:00:00.000Z',
    });
    vaultDecrypt.mockReturnValue('vault_probe_12345678_deadbeef');

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(12345678);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0xdeadbeef / 16 ** 8);

    const result = probeVaultCipherCycle({ surface: 'cli', command: 'doctor' });

    expect(result).toEqual({ ok: true });
    expect(vaultEncrypt).toHaveBeenCalledWith(
      '__vault_probe__',
      'vault_probe_12345678_deadbeef',
      expect.anything(),
    );
    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vault.bounded-use',
        status: 'allowed',
        details: expect.objectContaining({
          surface: 'cli',
          command: 'doctor',
          probe: 'cipher-cycle',
        }),
      }),
    );

    dateNow.mockRestore();
    randomSpy.mockRestore();
  });
  it.each([
    ['state', 'VAULT_STATE_AUTH_FAILED'],
    ['entry', 'VAULT_ENTRY_AUTH_FAILED'],
    ['bridge', 'BRIDGE_LOAD_FAILURE'],
    ['unknown', 'VAULT_SECRET_READ_FAILED'],
    ['tampered', 'VAULT_STATE_READER_UNAVAILABLE'],
  ])('keeps %s error classification consistent across facade operations', async (kind, code) => {
    const { readVaultSecretByKey, decryptVaultEntryValue, withVaultSecret } =
      await import('../../src/security/vault-boundary.js');
    const sentinel = 'synthetic-private-reader-classification';
    const entry = {
      key: 'first',
      id: 'fixture',
      encrypted: 'synthetic-ciphertext',
      iv: 'synthetic-nonce',
      createdAt: '2026-10-18T00:00:00Z',
      fingerprint: 'synthetic-ciphertext-fingerprint',
    };
    getLatestVaultEntry.mockReturnValue(entry);
    verifyVaultEntry.mockReturnValue(true);
    let original: Error;
    if (kind === 'state' || kind === 'tampered')
      original = new VaultStateError('VAULT_STATE_AUTH_FAILED');
    else if (kind === 'entry') original = new VaultEntryError('VAULT_ENTRY_AUTH_FAILED');
    else if (kind === 'bridge')
      original = new AppError('BRIDGE_LOAD_FAILURE', sentinel, 503, undefined, undefined, {
        secret: sentinel,
      });
    else original = new Error(sentinel, { cause: { authorization: sentinel } });
    original.message = sentinel;
    if (kind === 'tampered') Object.defineProperty(original, 'code', { value: sentinel });
    vaultDecrypt.mockImplementation(() => {
      throw original;
    });
    const named = readVaultSecretByKey('first', { surface: 'system' });
    const raw = decryptVaultEntryValue(entry, { surface: 'system' });
    let bounded: (Error & { errorCode?: string }) | undefined;
    try {
      withVaultSecret('first', { surface: 'system' }, (value) => value);
    } catch (error) {
      bounded = error as typeof bounded;
    }
    expect(named.errorCode).toBe(code);
    expect(raw).toMatchObject({ ok: false, errorCode: code });
    expect(bounded?.errorCode).toBe(code);
    expect(
      JSON.stringify({
        named,
        raw,
        bounded: {
          message: bounded?.message,
          errorCode: bounded?.errorCode,
          cause: bounded?.cause,
        },
        audit: writeSecurityAudit.mock.calls,
      }),
    ).not.toContain(sentinel);
  });
});
