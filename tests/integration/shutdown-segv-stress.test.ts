// Issue #270 evidence-driven close: spawn the runtime, send SIGTERM, assert
// the child exits without SEGV. Two stress paths, both env-gated by
// MEMPHIS_SEGV_STRESS=1:
//
//   1. `mcp serve --transport http` (N=20) — exercises the lighter mcp-serve
//      SIGTERM handler that just flips stopRequested. Regression guard
//      against process-static state added without a paired shutdown export.
//
//   2. `memphis serve` (N=10) — exercises the full bootstrap → installShutdown-
//      Handlers → performGracefulShutdown sequence (drain → embed_shutdown →
//      pino flush → exit). This is the path #270 actually points at; clean
//      runs here close the SEGV-on-shutdown hypothesis empirically.
//
// Phase 1 audit confirmed the only process-static state with a non-trivial
// Drop is EMBED_PIPELINE in crates/memphis-napi, already covered by
// embed_shutdown() in graceful-shutdown.ts. Vault and CaseIndex are per-call.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STRESS_ENABLED = process.env.MEMPHIS_SEGV_STRESS === '1';
const MCP_ITERATIONS = 20;
const DAEMON_ITERATIONS = 10;
const MCP_READY_TIMEOUT_MS = 8_000;
const MCP_STOP_TIMEOUT_MS = 6_000;
const DAEMON_READY_TIMEOUT_MS = 12_000;
const DAEMON_STOP_TIMEOUT_MS = 18_000;
const DAEMON_BASE_PORT = 45_000;

const thisDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(thisDir, '..', '..');
const MEMPHIS_BIN = join(REPO_ROOT, 'bin', 'memphis.js');

interface IterationResult {
  iteration: number;
  ready: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  durationMs: number;
  stderrTail: string;
}

async function runMcpServeIteration(iteration: number): Promise<IterationResult> {
  const isolatedRoot = mkdtempSync(join(tmpdir(), `memphis-segv-mcp-${iteration}-`));
  const env = {
    ...process.env,
    MEMPHIS_DATA_DIR: isolatedRoot,
    MEMPHIS_VAULT_STATE_PATH: join(isolatedRoot, 'vault-state.json'),
    MEMPHIS_VAULT_ENTRIES_PATH: join(isolatedRoot, 'vault-entries.json'),
    DEFAULT_PROVIDER: 'local-fallback',
    LOCAL_FALLBACK_ENABLED: 'true',
  };

  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [
      MEMPHIS_BIN,
      'mcp',
      'serve',
      '--transport',
      'http',
      '--port',
      '0',
      '--duration-ms',
      '0',
      '--json',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const ready = await waitForStdoutReady(child, MCP_READY_TIMEOUT_MS);
  if (!ready) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    await waitForExit(child, MCP_STOP_TIMEOUT_MS);
    rmSync(isolatedRoot, { recursive: true, force: true });
    return {
      iteration,
      ready: false,
      exitCode: null,
      exitSignal: null,
      durationMs: Date.now() - startedAt,
      stderrTail: stderr.slice(-500),
    };
  }

  child.kill('SIGTERM');
  const { code, signal } = await waitForExit(child, MCP_STOP_TIMEOUT_MS);
  rmSync(isolatedRoot, { recursive: true, force: true });

  return {
    iteration,
    ready: true,
    exitCode: code,
    exitSignal: signal,
    durationMs: Date.now() - startedAt,
    stderrTail: stderr.slice(-500),
  };
}

async function runFullDaemonIteration(iteration: number): Promise<IterationResult> {
  const isolatedRoot = mkdtempSync(join(tmpdir(), `memphis-segv-daemon-${iteration}-`));
  const port = DAEMON_BASE_PORT + iteration;
  const envFile = join(isolatedRoot, '.env');
  writeFileSync(
    envFile,
    [
      'HOST=127.0.0.1',
      `PORT=${port}`,
      'DEFAULT_PROVIDER=local-fallback',
      'LOCAL_FALLBACK_ENABLED=true',
      'RUST_EMBED_MODE=local',
      'RUST_CHAIN_ENABLED=true',
      'MEMPHIS_VAULT_PEPPER=segv-stress-pepper-1234567890',
      'MEMPHIS_API_TOKEN=',
      'MEMPHIS_CHANNEL_GATEWAY_ENABLED=false',
      '',
    ].join('\n'),
    'utf8',
  );

  const env = {
    ...process.env,
    MEMPHIS_ENV_FILE: envFile,
    MEMPHIS_DATA_DIR: isolatedRoot,
    MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
    MEMPHIS_SKIP_VAULT_INTEGRITY_PROBE: 'true',
    MEMPHIS_VAULT_STATE_PATH: join(isolatedRoot, 'vault-state.json'),
    MEMPHIS_VAULT_ENTRIES_PATH: join(isolatedRoot, 'vault-entries.json'),
    PORT: String(port),
  };

  const startedAt = Date.now();
  const child = spawn(process.execPath, [MEMPHIS_BIN, 'serve'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const ready = await waitForTcpReady(port, DAEMON_READY_TIMEOUT_MS, child);
  if (!ready) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    await waitForExit(child, DAEMON_STOP_TIMEOUT_MS);
    rmSync(isolatedRoot, { recursive: true, force: true });
    return {
      iteration,
      ready: false,
      exitCode: null,
      exitSignal: null,
      durationMs: Date.now() - startedAt,
      stderrTail: stderr.slice(-800),
    };
  }

  child.kill('SIGTERM');
  const { code, signal } = await waitForExit(child, DAEMON_STOP_TIMEOUT_MS);
  rmSync(isolatedRoot, { recursive: true, force: true });

  return {
    iteration,
    ready: true,
    exitCode: code,
    exitSignal: signal,
    durationMs: Date.now() - startedAt,
    stderrTail: stderr.slice(-800),
  };
}

function waitForStdoutReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolveReady) => {
    let buffer = '';
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolveReady(value);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // print() emits pretty-printed JSON (multi-line) when --json is set;
      // detect both fields together rather than parsing line-by-line.
      if (buffer.includes('"mode": "mcp-serve"') && buffer.includes('"ok": true')) {
        settle(true);
      }
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    child.stdout.on('data', onData);
    child.once('exit', () => settle(false));
  });
}

async function waitForTcpReady(
  port: number,
  timeoutMs: number,
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (await tryTcpConnect(port, 500)) return true;
    await sleep(250);
  }
  return false;
}

function tryTcpConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveTry) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveTry(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolveExit({ code, signal });
    });
  });
}

function summarize(label: string, results: IterationResult[]): void {
  const lines = results.map(
    (r) =>
      `  #${String(r.iteration).padStart(2, '0')}: ready=${r.ready} code=${r.exitCode} signal=${r.exitSignal} ms=${r.durationMs}`,
  );
  process.stderr.write(`[${label}] ${results.length} iterations:\n${lines.join('\n')}\n`);
}

function assertNoSegv(results: IterationResult[]): void {
  const segvHits = results.filter((r) => r.exitCode === 139 || r.exitSignal === 'SIGSEGV');
  const notReady = results.filter((r) => !r.ready);
  expect(
    notReady,
    `iterations failed to reach ready: ${JSON.stringify(notReady, null, 2)}`,
  ).toEqual([]);
  expect(
    segvHits,
    `iterations hit SEGV on shutdown: ${JSON.stringify(segvHits, null, 2)}`,
  ).toEqual([]);
}

describe.runIf(STRESS_ENABLED)('shutdown SEGV stress (issue #270 evidence)', () => {
  it(
    `mcp serve: ${MCP_ITERATIONS} spawn-then-SIGTERM cycles without SEGV`,
    async () => {
      const results: IterationResult[] = [];
      for (let i = 1; i <= MCP_ITERATIONS; i++) {
        results.push(await runMcpServeIteration(i));
      }
      summarize('shutdown-segv-stress mcp', results);
      assertNoSegv(results);
    },
    MCP_ITERATIONS * (MCP_READY_TIMEOUT_MS + MCP_STOP_TIMEOUT_MS) + 30_000,
  );

  it(
    `memphis serve (full bootstrap): ${DAEMON_ITERATIONS} spawn-then-SIGTERM cycles without SEGV`,
    async () => {
      const results: IterationResult[] = [];
      for (let i = 1; i <= DAEMON_ITERATIONS; i++) {
        results.push(await runFullDaemonIteration(i));
      }
      summarize('shutdown-segv-stress daemon', results);
      assertNoSegv(results);
    },
    DAEMON_ITERATIONS * (DAEMON_READY_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS) + 60_000,
  );
});
