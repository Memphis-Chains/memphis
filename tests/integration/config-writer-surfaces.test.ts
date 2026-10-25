import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { createCliContext } from '../../src/infra/cli/context.js';
import { configCommandHandler } from '../../src/infra/cli/handlers/config.handler.js';
import { parseCommand } from '../../src/infra/cli/parser.js';
import { setDotEnvValues, unsetDotEnvValues } from '../../src/infra/config/dotenv-file.js';
import { removeEnvVars, upsertEnvVars } from '../../src/infra/config/env-file.js';
import {
  getActiveRuntimeConfigSnapshot,
  initializeRuntimeConfigSnapshot,
  resetRuntimeConfigSnapshotForTests,
} from '../../src/infra/config/runtime-config-snapshot.js';
import { registerOperationalConfigRoutes } from '../../src/infra/http/routes/operational-config.js';
import { resetActiveVault } from '../../src/infra/storage/rust-vault-adapter.js';
import { executeTuiHostCommand } from '../../src/infra/tui-host/commands.js';
import { runMemphisConfigSet } from '../../src/mcp/tools/config.js';
import {
  __resetTier3SessionsForTests,
  __seedTier3SessionForTests,
} from '../../src/security/tier3-session.js';
import { readVaultSecretByKey } from '../../src/security/vault-boundary.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const pepperKey = 'MEMPHIS_VAULT_PEPPER';
const pepper = 'synthetic-state-reader-pepper';
const secret = 'synthetic-first-credential';

it('preserves an encrypted v2 vault and the process generation after refused config mutations', async () => {
  const originalEnv = process.env;
  const f = createIsolatedTestRuntime(originalEnv, resolve('.'));
  const app = Fastify();
  const messages: string[] = [];
  try {
    process.env = { ...f.env, [pepperKey]: pepper, MEMPHIS_TIER3_PERSIST: '0' };
    writeFileSync(f.env.MEMPHIS_ENV_FILE!, `OTHER=keep\n${pepperKey}=${pepper}\nTAIL=end\n`);
    writeFileSync(
      f.env.MEMPHIS_VAULT_STATE_PATH!,
      readFileSync('tests/fixtures/vault-state-v2.synthetic.json'),
    );
    const iv = Buffer.alloc(12, 5);
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), iv);
    const entry = {
      key: 'first',
      id: 'synthetic-config-writer-entry',
      encrypted: Buffer.concat([cipher.update(secret), cipher.final()]).toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      createdAt: '2026-10-19T00:00:00Z',
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ key: entry.key, encrypted: entry.encrypted, iv: entry.iv }))
      .digest('hex');
    writeFileSync(f.env.MEMPHIS_VAULT_ENTRIES_PATH!, JSON.stringify([{ ...entry, fingerprint }]));
    const before = new Map(
      [
        f.env.MEMPHIS_ENV_FILE!,
        f.env.MEMPHIS_VAULT_STATE_PATH!,
        f.env.MEMPHIS_VAULT_ENTRIES_PATH!,
      ].map((path) => [path, readFileSync(path)]),
    );
    const snapshot = initializeRuntimeConfigSnapshot();
    const assertPreserved = () => {
      for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
      expect(process.env[pepperKey]).toBe(pepper);
      expect(getActiveRuntimeConfigSnapshot()).toBe(snapshot);
      expect(process.env.MEMPHIS_CONFIG_GENERATION).toBe(String(snapshot.generation));
      expect(readVaultSecretByKey('first', { surface: 'system' }).plaintext).toBe(secret);
    };
    assertPreserved(); // Warm the real TS/NAPI credential cache before attempting writes.
    for (const value of ['synthetic-rejected-pepper', '']) {
      expect(() => setDotEnvValues({ [pepperKey]: value })).toThrow(/pepper-rotate/);
      assertPreserved();
      expect(() => upsertEnvVars([{ key: pepperKey, value }])).toThrow(/pepper-rotate/);
      assertPreserved();
      const mcp = runMemphisConfigSet({ key: pepperKey, value });
      expect(mcp).toMatchObject({ ok: false, reason: 'vault-rotation-required' });
      messages.push(JSON.stringify(mcp));
      assertPreserved();
    }
    for (const unset of [() => unsetDotEnvValues([pepperKey]), () => removeEnvVars([pepperKey])]) {
      expect(unset).toThrow(/pepper-rotate/);
      assertPreserved();
    }

    registerOperationalConfigRoutes(app);
    for (const value of ['synthetic-rejected-pepper', '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/config/set',
        payload: { key: pepperKey, value },
      });
      // HTTP has no elevated config-write route; its existing secret-field gate applies.
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, tier: 'secret' });
      messages.push(response.body);
      assertPreserved();
    }

    __seedTier3SessionForTests('tui', 'local');
    await expect(
      executeTuiHostCommand(
        'config.set',
        {
          key: pepperKey,
          value: 'synthetic-rejected-pepper',
        },
        {
          emitLine: (_level, text) => messages.push(text),
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/pepper-rotate/);
    assertPreserved();

    // The CLI handler currently exposes tools/surfaces, not generic `config set`.
    // Record its unsupported-command behavior without claiming a pepper-specific guard.
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation((text) => messages.push(String(text)));
    try {
      const argv = [
        'node',
        'memphis',
        'config',
        'set',
        pepperKey,
        '--value',
        'synthetic-rejected-pepper',
      ];
      expect(await configCommandHandler.handle(createCliContext(argv, parseCommand(argv)))).toBe(
        true,
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage: memphis config tools'));
    } finally {
      error.mockRestore();
    }
    assertPreserved();

    // A new process loads the unchanged dotenv, then independently reads through
    // TS/NAPI and native. This checks configuration reload, not an inherited pepper.
    const fresh = spawnSync(
      process.execPath,
      [
        '--import',
        resolve('node_modules/tsx/dist/loader.mjs'),
        resolve('tests/helpers/runtime-path-process.mts'),
        resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug/examples/runtime-path-fixture'),
      ],
      {
        env: { ...f.env, MEMPHIS_FIXTURE_EXPECTED: secret },
        encoding: 'utf8',
        timeout: 90000,
      },
    );
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({ readable: true, native: { readable: true } });
    assertPreserved();
    expect(messages.join('\n') + fresh.stdout + fresh.stderr).not.toContain(pepper);
    expect(messages.join('\n') + fresh.stdout + fresh.stderr).not.toContain(secret);
  } finally {
    await app.close();
    __resetTier3SessionsForTests();
    resetActiveVault();
    resetRuntimeConfigSnapshotForTests();
    process.env = originalEnv;
    rmSync(f.root, { recursive: true, force: true });
  }
}, 180000);
