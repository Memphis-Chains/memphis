import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runStartupSecurityGuards } from '../../src/app/bootstrap.js';
import { stopAlertRuntimeForTests } from '../../src/infra/logging/alert-runtime.js';
import { resolveEmergencyLogCandidates } from '../../src/infra/runtime/emergency-log.js';
import { EXIT_CODES } from '../../src/infra/runtime/exit-codes.js';

const tempDirs: string[] = [];

async function withEnv<T>(updates: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  stopAlertRuntimeForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('startup security alerts', () => {
  it('emits alert transport events for TrustRootRejected and StaleRevocationCache', async () => {
    const workspace = makeTempDir('memphis-startup-alert-send-');
    const homeDir = join(workspace, 'home');
    const dataDir = join(workspace, 'data');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const trustRootPath = join(workspace, 'trust_root_invalid.json');
    writeFileSync(trustRootPath, JSON.stringify({ version: 1, rootIds: [] }), 'utf8');

    const requests: Array<{ dedup_key?: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push(JSON.parse(body) as { dedup_key?: string });
        res.statusCode = 202;
        res.end('{}');
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      await withEnv(
        {
          HOME: homeDir,
          MEMPHIS_DATA_DIR: dataDir,
          MEMPHIS_STRICT_MODE: 'false',
          MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
          MEMPHIS_TRUST_ROOT_PATH: trustRootPath,
          MEMPHIS_REVOCATION_CACHE_REQUIRED: 'true',
          MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS: '30000',
          MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY: 'a'.repeat(32),
          MEMPHIS_ALERT_PAGERDUTY_ENDPOINT: `http://127.0.0.1:${port}/v2/enqueue`,
        },
        async () => {
          stopAlertRuntimeForTests();
          const guards = await runStartupSecurityGuards(process.env);
          expect(guards.trustRootStatus.valid).toBe(false);
          expect(guards.revocationCacheStatus.stale).toBe(true);
        },
      );

      const dedupKeys = requests.map((entry) => entry.dedup_key).sort();
      expect(dedupKeys).toEqual(['StaleRevocationCache', 'TrustRootRejected']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('falls back to emergency log when alert transport send fails', async () => {
    const workspace = makeTempDir('memphis-startup-alert-fallback-');
    const homeDir = join(workspace, 'home');
    const dataDir = join(workspace, 'data');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const trustRootPath = join(workspace, 'trust_root_invalid.json');
    writeFileSync(trustRootPath, JSON.stringify({ version: 1, rootIds: [] }), 'utf8');

    const matched = await withEnv(
      {
        HOME: homeDir,
        MEMPHIS_DATA_DIR: dataDir,
        MEMPHIS_STRICT_MODE: 'false',
        MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
        MEMPHIS_TRUST_ROOT_PATH: trustRootPath,
        MEMPHIS_REVOCATION_CACHE_REQUIRED: 'false',
        MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY: 'b'.repeat(32),
        MEMPHIS_ALERT_PAGERDUTY_ENDPOINT: 'http://127.0.0.1:1/v2/enqueue',
        MEMPHIS_ALERT_HTTP_TIMEOUT_MS: '250',
      },
      async () => {
        stopAlertRuntimeForTests();
        await runStartupSecurityGuards(process.env);
        const candidates = resolveEmergencyLogCandidates(process.env, { cwdPath: workspace });
        const logs = candidates
          .filter((candidate) => existsSync(candidate))
          .map((candidate) => ({
            path: candidate,
            content: readFileSync(candidate, 'utf8'),
          }));
        return logs.find(
          (entry) =>
            entry.content.includes('[ALERT_FALLBACK]') &&
            entry.content.includes('TrustRootRejected'),
        );
      },
    );
    expect(matched).toBeDefined();
  });

  it('throws ERR_TRUST_ROOT in strict mode when trust-root validation fails', async () => {
    const workspace = makeTempDir('memphis-startup-alert-strict-trust-');
    const trustRootPath = join(workspace, 'missing-trust-root.json');

    await withEnv(
      {
        MEMPHIS_STRICT_MODE: 'true',
        MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
        MEMPHIS_TRUST_ROOT_PATH: trustRootPath,
        MEMPHIS_REVOCATION_CACHE_REQUIRED: 'false',
      },
      async () => {
        stopAlertRuntimeForTests();
        await expect(
          runStartupSecurityGuards(process.env, {
            writeSecurityEvent: async () => ({
              wroteChain: false,
              wroteSyslog: false,
              wroteEmergency: false,
            }),
          }),
        ).rejects.toMatchObject({ exitCode: EXIT_CODES.ERR_TRUST_ROOT });
      },
    );
  });
});
