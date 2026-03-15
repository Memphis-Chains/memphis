import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStartupSecurityGuards } from '../src/app/bootstrap.js';
import { EXIT_CODES, resolveExitCode } from '../src/infra/runtime/exit-codes.js';
import {
  getStartupRevocationCacheStatus,
  getStartupTrustRootStatus,
  resetStartupRuntimeStateForTests,
} from '../src/infra/runtime/startup-state.js';

type DrillResult = {
  name: string;
  ok: boolean;
  detail: string;
};

type OutputMode = 'text' | 'json';

const noopSecurityWrite = async () => ({
  wroteChain: false,
  wroteSyslog: false,
  wroteEmergency: false,
});

async function runTrustRootStrictDrill(tempDir: string): Promise<DrillResult> {
  resetStartupRuntimeStateForTests();
  const missingTrustRoot = join(tempDir, 'missing-trust-root.json');

  let thrown: unknown;
  try {
    await runStartupSecurityGuards(
      {
        MEMPHIS_STRICT_MODE: 'true',
        MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
        MEMPHIS_TRUST_ROOT_PATH: missingTrustRoot,
        MEMPHIS_REVOCATION_CACHE_REQUIRED: 'false',
      } as NodeJS.ProcessEnv,
      { writeSecurityEvent: noopSecurityWrite },
    );
  } catch (error) {
    thrown = error;
  }

  const exitCode = resolveExitCode(thrown);
  const trust = getStartupTrustRootStatus();
  const ok =
    exitCode === EXIT_CODES.ERR_TRUST_ROOT && trust?.enabled === true && trust.valid === false;
  return {
    name: 'trust-root-invalid-strict',
    ok,
    detail: `exitCode=${exitCode} trust.valid=${trust?.valid ?? 'null'} reason=${trust?.reason ?? 'none'}`,
  };
}

async function runRevocationStaleDrill(): Promise<DrillResult> {
  resetStartupRuntimeStateForTests();
  const nowMs = 200_000;
  await runStartupSecurityGuards(
    {
      MEMPHIS_STRICT_MODE: 'false',
      MEMPHIS_TRUST_ROOT_REQUIRED: 'false',
      MEMPHIS_REVOCATION_CACHE_REQUIRED: 'true',
      MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS: '30000',
      MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS: '1000',
    } as NodeJS.ProcessEnv,
    {
      nowMs,
      writeSecurityEvent: noopSecurityWrite,
    },
  );

  const revocation = getStartupRevocationCacheStatus();
  const ok =
    revocation?.enabled === true && revocation.stale === true && (revocation.ageMs ?? 0) > 30_000;
  return {
    name: 'revocation-stale',
    ok,
    detail: `stale=${revocation?.stale ?? 'null'} ageMs=${revocation?.ageMs ?? 'null'} maxStaleMs=${revocation?.maxStaleMs ?? 'null'}`,
  };
}

async function main(): Promise<void> {
  const outputMode: OutputMode = process.argv.includes('--json') ? 'json' : 'text';
  const tempDir = mkdtempSync(join(tmpdir(), 'memphis-guard-drill-'));
  const results: DrillResult[] = [];

  try {
    results.push(await runTrustRootStrictDrill(tempDir));
    results.push(await runRevocationStaleDrill());
  } finally {
    resetStartupRuntimeStateForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (outputMode === 'json') {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          ok: results.every((result) => result.ok),
          scenarios: results,
        },
        null,
        2,
      ),
    );
  } else {
    for (const result of results) {
      const prefix = result.ok ? '[PASS]' : '[FAIL]';
      console.log(`${prefix} ${result.name} ${result.detail}`);
    }
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    `[FAIL] guard-failure-drill ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
