import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { read, save, list, authorize } = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock('../../src/security/vault-boundary.js', () => ({
  readVaultSecretByKey: read,
  storeVaultSecret: save,
  listVaultEntryMetadata: list,
}));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: authorize,
  isSessionAuthorized: vi.fn(() => true),
  recoverOperatorPassphrase: vi.fn(),
}));

import { AppError } from '../../src/core/errors.js';
import type { CliContext } from '../../src/infra/cli/context.js';
import { secretCommandHandler } from '../../src/infra/cli/handlers/secret.handler.js';
import { MemphisExitError } from '../../src/infra/runtime/exit-codes.js';
import { VaultEntryError, VaultStateError } from '../../src/infra/storage/rust-vault-adapter.js';

const initialExitCode = process.exitCode;
const secret = 'synthetic-private-secret-cli-context';
function context(command: string, json = true): CliContext {
  return {
    args: {
      command: 'secret',
      subcommand: command,
      json,
      key: 'fixture',
      value: 'synthetic-private-provided-value',
    },
  } as CliContext;
}
async function invoke(command: string, json = true) {
  let stdout = '';
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  });
  const err = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  let handled: boolean | undefined;
  let failure: unknown;
  try {
    handled = await secretCommandHandler.handle(context(command, json));
  } catch (error) {
    failure = error;
  } finally {
    out.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
  let data: Record<string, unknown> | undefined;
  try {
    data = JSON.parse(stdout);
  } catch {
    /* asserted below */
  }
  return { handled, failure, stdout, stderr, data, exitCode: process.exitCode };
}

describe('secret CLI operation failure contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.exitCode = undefined;
    authorize.mockResolvedValue(true);
    read.mockReturnValue({ found: true, key: 'fixture', plaintext: 'synthetic-success' });
    save.mockReturnValue({
      fingerprint: 'ciphertext-fingerprint',
      createdAt: '2026-10-18T00:00:00Z',
    });
    list.mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = initialExitCode;
  });
  it.each([
    ['add', 'VAULT_SECRET_WRITE_FAILED'],
    ['get', 'VAULT_SECRET_READ_FAILED'],
    ['list', 'VAULT_METADATA_UNAVAILABLE'],
  ])(
    '%s projects an unexpected operation error into JSON and a failing exit',
    async (command, code) => {
      const operation = command === 'add' ? save : command === 'get' ? read : list;
      operation.mockImplementation(() => {
        throw new Error(secret, { cause: { authorization: secret } });
      });
      const result = await invoke(command);
      expect.soft(result.failure).toBeUndefined();
      expect.soft(result.handled).toBe(true);
      expect.soft(result.data).toMatchObject({ ok: false, code });
      expect.soft(result.exitCode).toBe(1);
      expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).not.toContain(
        secret,
      );
      expect(JSON.stringify(result.data)).not.toContain('synthetic-private-provided-value');
    },
  );
  it.each([
    ['add', () => new VaultStateError('VAULT_STATE_AUTH_FAILED'), 'VAULT_STATE_AUTH_FAILED'],
    [
      'get',
      () => new AppError('BRIDGE_LOAD_FAILURE', secret, 503, undefined, undefined, { key: secret }),
      'BRIDGE_LOAD_FAILURE',
    ],
    ['list', () => new VaultEntryError('VAULT_ENTRIES_MALFORMED'), 'VAULT_ENTRIES_MALFORMED'],
  ] as const)(
    '%s preserves a known code without trusting its message',
    async (command, makeError, code) => {
      const error = makeError();
      error.message = secret;
      (command === 'add' ? save : command === 'get' ? read : list).mockImplementation(() => {
        throw error;
      });
      const result = await invoke(command);
      expect(result.failure).toBeUndefined();
      expect(result.data).toMatchObject({ ok: false, code });
      expect(result.exitCode).toBe(1);
      expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).not.toContain(
        secret,
      );
    },
  );
  it('reports a normal read failure as a nonzero JSON result', async () => {
    read.mockReturnValue({
      found: true,
      key: 'fixture',
      error: 'Vault entry decryption failed',
      errorCode: 'VAULT_STATE_AUTH_FAILED',
    });
    const result = await invoke('get');
    expect(result.data).toMatchObject({ ok: false, code: 'VAULT_STATE_AUTH_FAILED' });
    expect(result.exitCode).toBe(1);
  });
  it('reports a missing requested key without a successful exit', async () => {
    read.mockReturnValue({ found: false, key: 'fixture' });
    const result = await invoke('get');
    expect(result.data).toMatchObject({ ok: false, code: 'VAULT_ENTRY_NOT_FOUND' });
    expect(result.exitCode).toBe(1);
  });
  it('keeps opaque errors out of human output too', async () => {
    save.mockImplementation(() => {
      throw new Error(secret);
    });
    const result = await invoke('add', false);
    expect(result.failure).toBeUndefined();
    expect(result.stderr.join(' ')).not.toContain(secret);
    expect(result.exitCode).toBe(1);
  });
  it.each([101, 102, 103] as const)(
    'preserves hardening exit %s without serializing context',
    async (code) => {
      read.mockImplementation(() => {
        throw new MemphisExitError(code, secret, { authorization: secret });
      });
      const result = await invoke('get');
      expect(result.failure).toBeUndefined();
      expect(result.exitCode).toBe(code);
      expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).not.toContain(
        secret,
      );
    },
  );
  it('does not overwrite an existing hardening exit with a general failure', async () => {
    process.exitCode = 103;
    list.mockImplementation(() => {
      throw new Error(secret);
    });
    const result = await invoke('list');
    expect(result.failure).toBeUndefined();
    expect(result.exitCode).toBe(103);
  });
  it.each(['add', 'get', 'list'])('%s success keeps a successful exit', async (command) => {
    const result = await invoke(command);
    expect(result.failure).toBeUndefined();
    expect(result.data?.ok ?? true).toBe(true);
    expect(Number(result.exitCode ?? 0)).toBe(0);
  });
  it('denies before calling any vault operation', async () => {
    authorize.mockResolvedValue(false);
    const result = await invoke('get');
    expect(result.failure).toBeInstanceOf(Error);
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it('supplies a fallback code for a legacy read failure without errorCode', async () => {
    read.mockReturnValue({ found: true, key: 'fixture', error: 'Vault entry decryption failed' });
    const result = await invoke('get');
    expect(result.data).toMatchObject({ ok: false, code: 'VAULT_SECRET_READ_FAILED' });
    expect(result.exitCode).toBe(1);
  });
  it.each(['add', 'get', 'list'])('%s keeps hostile exception proxies opaque', async (command) => {
    const error = new Proxy(new Error(secret), {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
      getPrototypeOf() {
        throw new Error(secret);
      },
    });
    (command === 'add' ? save : command === 'get' ? read : list).mockImplementation(() => {
      throw error;
    });
    const result = await invoke(command);
    expect(result.failure).toBeUndefined();
    expect(result.data?.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).not.toContain(secret);
  });
  it('does not invoke a known exception code getter', async () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const error = Object.defineProperty(new VaultEntryError('VAULT_ENTRIES_MALFORMED'), 'code', {
      get: getter,
    });
    list.mockImplementation(() => {
      throw error;
    });
    const result = await invoke('list');
    expect(result.failure).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ ok: false, code: 'VAULT_ENTRY_READER_UNAVAILABLE' });
    expect(result.exitCode).toBe(1);
  });
  it('does not let an exception exit-code getter control the status', async () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const error = Object.defineProperty(new MemphisExitError(103, secret), 'exitCode', {
      get: getter,
    });
    read.mockImplementation(() => {
      throw error;
    });
    const result = await invoke('get');
    expect(result.failure).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).not.toContain(secret);
  });
});
