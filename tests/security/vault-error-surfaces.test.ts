import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rotate, init, audit, encrypt, decrypt, save } = vi.hoisted(() => ({
  rotate: vi.fn(),
  init: vi.fn(),
  audit: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../../src/infra/storage/rust-vault-adapter.js', async (original) => ({
  ...(await original<typeof import('../../src/infra/storage/rust-vault-adapter.js')>()),
  rotateVaultMasterKey: rotate,
  vaultInit: init,
  vaultEncrypt: encrypt,
  vaultDecrypt: decrypt,
}));
vi.mock('../../src/infra/storage/vault-entry-store.js', async (original) => ({
  ...(await original<typeof import('../../src/infra/storage/vault-entry-store.js')>()),
  saveVaultEntry: save,
}));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
  recoverOperatorPassphrase: vi.fn(),
}));
vi.mock('../../src/infra/logging/security-audit.js', () => ({ writeSecurityAudit: audit }));

import { createCliContext } from '../../src/infra/cli/context.js';
import { vaultCommandHandler } from '../../src/infra/cli/handlers/vault.handler.js';
import { parseCommand } from '../../src/infra/cli/parser.js';
import { registerVaultRoutes } from '../../src/infra/http/routes/vault.js';
import {
  VaultAlreadyInitializedError,
  VaultStateError,
} from '../../src/infra/storage/rust-vault-adapter.js';

describe('vault transport safe failures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it('keeps rotation exception text out of the audit and the command error', async () => {
    const sentinel = 'synthetic-private-rotation-value';
    rotate.mockImplementation(() => {
      throw new Error(sentinel, { cause: { headers: { Authorization: sentinel } } });
    });
    const argv = ['node', 'memphis', 'vault', 'master-key-rotate', '--confirm', '--json'];
    const context = createCliContext(argv, parseCommand(argv));
    const failure = await vaultCommandHandler.handle(context).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(audit).toHaveBeenCalled();
    expect(
      JSON.stringify({
        message: (failure as Error).message,
        cause: (failure as Error).cause,
        audit: audit.mock.calls,
      }),
    ).not.toContain(sentinel);
  });

  it('returns an initialization failure without backend, request or header credentials', async () => {
    const backendSentinel = 'synthetic-private-http-backend';
    const requestSentinel = 'synthetic-private-http-request';
    const headerSentinel = 'synthetic-private-http-header';
    audit.mockClear();
    init.mockImplementation(() => {
      throw new Error(backendSentinel, { cause: { Authorization: headerSentinel } });
    });
    const app = Fastify();
    registerVaultRoutes(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/vault/init',
        headers: { authorization: `Bearer ${headerSentinel}` },
        payload: {
          passphrase: requestSentinel,
          recovery_question: 'fixture?',
          recovery_answer: requestSentinel,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain('Vault initialization failed');
      const observed = JSON.stringify({ response: response.json(), audit: audit.mock.calls });
      for (const sentinel of [backendSentinel, requestSentinel, headerSentinel])
        expect(observed).not.toContain(sentinel);
    } finally {
      await app.close();
    }
  });
  it.each(['init', 'encrypt', 'decrypt', 'entries'] as const)(
    '%s does not serialize an audit persistence exception',
    async (operation) => {
      const sentinel = 'synthetic-private-audit-dependency';
      const entry = {
        key: 'fixture',
        id: 'synthetic-entry',
        encrypted: Buffer.alloc(32, 1).toString('base64'),
        iv: Buffer.alloc(12, 1).toString('base64'),
        tag: Buffer.alloc(16, 1).toString('base64'),
        createdAt: '2026-10-18T00:00:00Z',
        fingerprint: 'synthetic-ciphertext-fingerprint',
      };
      init.mockReturnValue({ version: 2, did: 'did:memphis:123456789ABCDEFGHJKLMNPQRSTUVWXYZ' });
      encrypt.mockReturnValue(entry);
      save.mockReturnValue(entry);
      decrypt.mockReturnValue('synthetic-decrypted-credential');
      audit.mockImplementation(() => {
        throw new Error(sentinel, { cause: { Authorization: sentinel } });
      });
      const app = Fastify();
      registerVaultRoutes(app);
      try {
        const payload =
          operation === 'init'
            ? {
                passphrase: 'synthetic-strong-passphrase',
                recovery_question: 'fixture?',
                recovery_answer: 'synthetic-answer',
              }
            : operation === 'encrypt'
              ? { key: 'fixture', plaintext: 'synthetic-decrypted-credential' }
              : { entry };
        const response = await app.inject({
          method: operation === 'entries' ? 'GET' : 'POST',
          url: '/v1/vault/' + operation,
          ...(operation === 'entries' ? {} : { payload }),
        });
        expect.soft(response.statusCode).toBe(503);
        expect(JSON.stringify(response.json())).not.toContain(sentinel);
        expect(JSON.stringify(response.json())).not.toContain('synthetic-decrypted-credential');
      } finally {
        await app.close();
      }
    },
  );

  it('does not trust arbitrary message text on an already-initialized error', async () => {
    const sentinel = 'synthetic-private-reinit-message';
    init.mockImplementation(() => {
      throw new VaultAlreadyInitializedError(sentinel);
    });
    const app = Fastify();
    registerVaultRoutes(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/vault/init',
        payload: {
          passphrase: 'synthetic-strong-passphrase',
          recovery_question: 'fixture?',
          recovery_answer: 'synthetic-answer',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('VAULT_ALREADY_INITIALIZED');
      expect(JSON.stringify(response.json())).not.toContain(sentinel);
    } finally {
      await app.close();
    }
  });

  it('preserves a safe state-reader code at the HTTP boundary', async () => {
    init.mockImplementation(() => {
      throw new VaultStateError('VAULT_STATE_AUTH_FAILED');
    });
    const app = Fastify();
    registerVaultRoutes(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/vault/init',
        payload: {
          passphrase: 'synthetic-strong-passphrase',
          recovery_question: 'fixture?',
          recovery_answer: 'synthetic-answer',
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('VAULT_STATE_AUTH_FAILED');
    } finally {
      await app.close();
    }
  });
  it.each(['init', 'encrypt', 'decrypt'])(
    '%s validation does not leak a failed blocked-audit write',
    async (operation) => {
      const sentinel = 'synthetic-private-validation-audit';
      audit.mockImplementation(() => {
        throw new Error(sentinel, { cause: { secret: sentinel } });
      });
      const logs: string[] = [];
      const app = Fastify({
        logger: {
          level: 'error',
          stream: {
            write: (line: string) => {
              logs.push(line);
            },
          },
        },
      });
      registerVaultRoutes(app);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/vault/' + operation,
          headers: { authorization: 'Bearer ' + sentinel },
          payload: { invalid: true },
        });
        expect.soft(response.statusCode).toBe(503);
        expect(JSON.stringify({ response: response.json(), logs })).not.toContain(sentinel);
      } finally {
        await app.close();
      }
    },
  );
});
