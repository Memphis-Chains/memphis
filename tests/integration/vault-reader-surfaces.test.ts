import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// This fixture tests reader/error semantics; authorization is tested separately.
vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
  isSessionAuthorized: vi.fn(() => true),
  recoverOperatorPassphrase: vi.fn(),
}));
vi.mock('../../src/infra/logging/security-audit.js', () => ({ writeSecurityAudit: vi.fn() }));

import { createCliContext } from '../../src/infra/cli/context.js';
import { secretCommandHandler } from '../../src/infra/cli/handlers/secret.handler.js';
import { parseCommand } from '../../src/infra/cli/parser.js';
import { registerVaultRoutes } from '../../src/infra/http/routes/vault.js';
import { resetActiveVault } from '../../src/infra/storage/rust-vault-adapter.js';
import { runMemphisVaultGet } from '../../src/mcp/tools/vault-get.js';
import {
  decryptVaultEntryValue,
  readVaultSecretByKey,
  withVaultSecret,
} from '../../src/security/vault-boundary.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const initialEnv = process.env;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetActiveVault();
  process.env = initialEnv;
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
const nativeReader = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug/examples/vault-read-fixture',
);
const golden = JSON.parse(readFileSync('tests/fixtures/vault-state-v2.synthetic.json', 'utf8'));
const secret = 'synthetic-first-credential';
const sentinel = 'synthetic-private-reader-error-value';

function fixture(kind: string) {
  const f = createIsolatedTestRuntime(initialEnv, resolve('.'));
  roots.push(f.root);
  delete f.env.MEMPHIS_VAULT_PEPPER;
  const master = Buffer.alloc(32, 2);
  const cipher = createCipheriv(
    'aes-256-gcm',
    kind === 'entry-auth' ? Buffer.alloc(32, 3) : master,
    Buffer.alloc(12, 5),
  );
  const plain = kind === 'invalid-text' ? Buffer.from([0xff, 0xfe]) : Buffer.from(secret);
  const entry = {
    key: 'first',
    id: 'synthetic-entry',
    encrypted: Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64'),
    iv: Buffer.alloc(12, 5).toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    createdAt: '2026-10-18T00:00:00Z',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ key: entry.key, encrypted: entry.encrypted, iv: entry.iv }))
    .digest('hex');
  writeFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, JSON.stringify([{ ...entry, fingerprint }]), {
    mode: 0o600,
  });
  if (kind === 'malformed')
    writeFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!, '{' + sentinel, { mode: 0o600 });
  else if (kind === 'state-auth') {
    writeFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!, JSON.stringify(golden), { mode: 0o600 });
    f.env.MEMPHIS_VAULT_PEPPER = sentinel;
  } else if (kind === 'unsupported-version' || kind === 'missing-pepper') {
    writeFileSync(
      f.env.MEMPHIS_VAULT_STATE_PATH!,
      JSON.stringify(kind === 'unsupported-version' ? { ...golden, version: 3 } : golden),
      { mode: 0o600 },
    );
  } else if (kind !== 'missing-state')
    writeFileSync(
      f.env.MEMPHIS_VAULT_STATE_PATH!,
      JSON.stringify({
        salt: Buffer.alloc(32, 1).toString('base64'),
        masterKey: master.toString('base64'),
      }),
      { mode: 0o600 },
    );
  master.fill(0);
  plain.fill(0);
  return { ...f, entry };
}

async function cliRead() {
  const previousExitCode = process.exitCode;
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
  let exitCode: typeof process.exitCode;
  try {
    const argv = ['node', 'memphis', 'secret', 'get', '--key', 'first', '--json'];
    await secretCommandHandler.handle(createCliContext(argv, parseCommand(argv)));
    exitCode = process.exitCode;
  } finally {
    process.exitCode = previousExitCode;
    out.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(stdout);
  } catch {
    /* Missing JSON is an explicit contract assertion below. */
  }
  return { data, stdout, stderr, exitCode };
}

describe('one encrypted fixture across credential reader surfaces', () => {
  it.each([
    ['readable', undefined],
    ['missing-state', 'VAULT_STATE_MISSING'],
    ['malformed', 'VAULT_STATE_MALFORMED'],
    ['state-auth', 'VAULT_STATE_AUTH_FAILED'],
    ['unsupported-version', 'VAULT_STATE_UNSUPPORTED_VERSION'],
    ['missing-pepper', 'VAULT_PEPPER_REQUIRED'],
    ['entry-auth', 'VAULT_ENTRY_AUTH_FAILED'],
    ['invalid-text', 'VAULT_ENTRY_INVALID_TEXT'],
  ] as const)(
    '%s preserves reader outcome without private failure context',
    async (kind, code) => {
      const f = fixture(kind);
      process.env = f.env;
      const originalState = existsSync(f.env.MEMPHIS_VAULT_STATE_PATH!)
        ? readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!)
        : undefined;
      const originalEntries = readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!);
      const named = readVaultSecretByKey('first', { surface: 'system' }, f.env);
      const raw = decryptVaultEntryValue(f.entry, { surface: 'system' }, f.env);
      let bounded: { value?: string; errorCode?: string; message?: string };
      try {
        bounded = {
          value: withVaultSecret('first', { surface: 'system' }, (value) => value, f.env),
        };
      } catch (error) {
        bounded = {
          errorCode: (error as { errorCode?: string }).errorCode,
          message: error instanceof Error ? error.message : 'unknown',
        };
      }
      const mcp = runMemphisVaultGet({ key: 'first' });
      const cli = await cliRead();
      const app = Fastify();
      registerVaultRoutes(app);
      let http: Record<string, unknown>;
      let status: number;
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/vault/decrypt',
          payload: { entry: f.entry },
        });
        http = response.json();
        status = response.statusCode;
      } finally {
        await app.close();
      }
      const native = spawnSync(nativeReader, [], {
        env: {
          ...f.env,
          MEMPHIS_FIXTURE_VAULT_KEY: 'first',
          MEMPHIS_FIXTURE_VAULT_EXPECTED: secret,
        },
        encoding: 'utf8',
        timeout: 60000,
      });
      if (code) {
        expect.soft(named.errorCode, 'named TS/NAPI').toBe(code);
        expect.soft((raw as { errorCode?: string }).errorCode, 'raw-entry facade').toBe(code);
        expect.soft((mcp as { errorCode?: string }).errorCode, 'MCP named export').toBe(code);
        expect.soft(bounded.errorCode, 'bounded use classified failure').toBe(code);
        expect.soft(cli.data?.code, 'CLI --json structured failure').toBe(code);
        expect.soft(cli.exitCode, 'CLI failed read exit').toBe(1);
        expect.soft(http.code, 'HTTP raw-entry structured failure').toBe(code);
        expect.soft(status).toBe(503);
        expect.soft(native.status, native.stderr).toBe(3);
        expect.soft(native.stderr).toContain(code);
        const observed = JSON.stringify({
          named,
          raw,
          mcp,
          bounded,
          cli,
          http,
          native: { stdout: native.stdout, stderr: native.stderr },
        });
        expect(observed).not.toContain(sentinel);
        expect(observed).not.toContain(secret);
      } else {
        // Explicit authorized export is separate from a diagnostic: plaintext here
        // is intentional. Native fixture reports only its successful comparison.
        expect(named.plaintext).toBe(secret);
        expect(raw).toMatchObject({ ok: true, plaintext: secret });
        expect(mcp.plaintext).toBe(secret);
        expect(bounded.value).toBe(secret);
        expect(cli.data?.value).toBe(secret);
        expect(http).toMatchObject({ ok: true, plaintext: secret });
        expect(status).toBe(200);
        expect(native.status, native.stderr).toBe(0);
        expect(native.stdout.trim()).toBe('NATIVE_VAULT_OK');
        expect(native.stdout + native.stderr).not.toContain(secret);
      }
      expect(readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!)).toEqual(originalEntries);
      if (originalState)
        expect(readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!)).toEqual(originalState);
      else expect(existsSync(f.env.MEMPHIS_VAULT_STATE_PATH!)).toBe(false);
    },
    180000,
  );
  it('distinguishes a missing stored key from explicit raw-entry decryption', async () => {
    const f = fixture('readable');
    process.env = f.env;
    writeFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, '[]', { mode: 0o600 });
    const state = readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!);
    expect(readVaultSecretByKey('first', { surface: 'system' }, f.env)).toMatchObject({
      found: false,
    });
    expect(runMemphisVaultGet({ key: 'first' })).toMatchObject({ found: false });
    const cli = await cliRead();
    expect(cli.data).toMatchObject({ ok: false, key: 'first' });
    expect(cli.exitCode).toBe(1);
    let boundedCode: string | undefined;
    try {
      withVaultSecret('first', { surface: 'system' }, (value) => value, f.env);
    } catch (error) {
      boundedCode = (error as { errorCode?: string }).errorCode;
    }
    expect(boundedCode).toBe('VAULT_ENTRY_NOT_FOUND');
    const raw = decryptVaultEntryValue(f.entry, { surface: 'system' }, f.env);
    expect(raw).toEqual({ ok: true, plaintext: secret });
    const app = Fastify();
    registerVaultRoutes(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/vault/decrypt',
        payload: { entry: f.entry },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, plaintext: secret });
    } finally {
      await app.close();
    }
    const native = spawnSync(nativeReader, [], { env: f.env, encoding: 'utf8', timeout: 60000 });
    expect(native.status, native.stderr).toBe(3);
    expect(native.stderr).toContain('VAULT_ENTRY_NOT_FOUND');
    expect(native.stdout + native.stderr + JSON.stringify(cli)).not.toContain(secret);
    expect(readFileSync(f.env.MEMPHIS_VAULT_STATE_PATH!)).toEqual(state);
    expect(readFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, 'utf8')).toBe('[]');
  });
});
