import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

type Stats = {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
};

type BenchOutput = {
  generatedAt: string;
  cliEntry: string;
  cliStartup: {
    samples: number[];
    stats: Stats;
  };
  tuiRefresh: {
    samples: number[];
    stats: Stats;
    sessions: number;
    commandsPerSession: number;
    commands: string[];
  };
};

const STARTUP_SAMPLES = Number(process.env.BENCH_CLI_STARTUP_SAMPLES ?? '12');
const STARTUP_WARMUPS = Number(process.env.BENCH_CLI_STARTUP_WARMUPS ?? '2');
const TUI_SESSIONS = Number(process.env.BENCH_TUI_REFRESH_SESSIONS ?? '3');
const TIMEOUT_MS = Number(process.env.BENCH_TUI_TIMEOUT_MS ?? '15000');

const TUI_COMMANDS = ['/help', '/obs', '/screen chat', '/screen dashboard'];

function summarize(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, n) => sum + n, 0) / Math.max(1, sorted.length);
  const at = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
    return sorted[idx] ?? 0;
  };
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  };
}

function round(values: number[]): number[] {
  return values.map((n) => Number(n.toFixed(2)));
}

function roundStats(stats: Stats): Stats {
  return {
    min: Number(stats.min.toFixed(2)),
    max: Number(stats.max.toFixed(2)),
    avg: Number(stats.avg.toFixed(2)),
    p50: Number(stats.p50.toFixed(2)),
    p95: Number(stats.p95.toFixed(2)),
    p99: Number(stats.p99.toFixed(2)),
  };
}

function resolveCliEntry(): string {
  const distEntry = resolve('dist/infra/cli/index.js');
  const srcEntry = resolve('src/infra/cli/index.ts');
  if (existsSync(distEntry)) return distEntry;
  return srcEntry;
}

function benchmarkEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DEFAULT_PROVIDER: 'local-fallback',
    MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
    RUST_CHAIN_ENABLED: 'false',
  };
}

async function runCliProcess(entry: string, args: string[]): Promise<{ code: number | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [entry, ...args], {
      cwd: resolve('.'),
      env: benchmarkEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`process timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolvePromise({ code });
    });
  });
}

async function measureCliStartup(entry: string): Promise<number> {
  const started = performance.now();
  const result = await runCliProcess(entry, ['--help']);
  if (result.code !== 0) {
    throw new Error(`cli --help exited with code ${String(result.code)}`);
  }
  return performance.now() - started;
}

type PromptWatcher = {
  waitForPrompt: () => Promise<void>;
  dispose: () => void;
};

function createPromptWatcher(
  child: ReturnType<typeof spawn>,
  promptToken: string,
  timeoutMs: number,
): PromptWatcher {
  let buffer = '';
  let cursor = 0;
  let pending:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    if (buffer.length > 200_000) {
      buffer = buffer.slice(-100_000);
      cursor = Math.min(cursor, buffer.length);
    }

    if (!pending) return;
    const idx = buffer.indexOf(promptToken, cursor);
    if (idx === -1) return;

    cursor = idx + promptToken.length;
    const active = pending;
    pending = undefined;
    clearTimeout(active.timer);
    active.resolve();
  };

  const onClose = () => {
    if (!pending) return;
    const active = pending;
    pending = undefined;
    clearTimeout(active.timer);
    active.reject(new Error('tui process closed before prompt appeared'));
  };

  child.stdout?.on('data', onData);
  child.on('close', onClose);

  return {
    waitForPrompt: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        if (pending) {
          rejectPromise(new Error('waitForPrompt called while a prompt wait is already pending'));
          return;
        }

        const idx = buffer.indexOf(promptToken, cursor);
        if (idx !== -1) {
          cursor = idx + promptToken.length;
          resolvePromise();
          return;
        }

        const timer = setTimeout(() => {
          if (!pending) return;
          pending = undefined;
          rejectPromise(new Error(`timed out waiting for prompt token "${promptToken}"`));
        }, timeoutMs);

        pending = { resolve: resolvePromise, reject: rejectPromise, timer };
      }),
    dispose: () => {
      child.stdout?.off('data', onData);
      child.off('close', onClose);
      if (pending) {
        clearTimeout(pending.timer);
        pending = undefined;
      }
    },
  };
}

async function measureTuiRefreshSession(entry: string, commands: string[]): Promise<number[]> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [entry, 'tui'], {
      cwd: resolve('.'),
      env: benchmarkEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const watcher = createPromptWatcher(child, 'memphis:tui> ', TIMEOUT_MS);
    const latencies: number[] = [];

    const fail = (error: Error): void => {
      watcher.dispose();
      child.kill('SIGKILL');
      rejectPromise(error);
    };

    child.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));

    void (async () => {
      try {
        await watcher.waitForPrompt();

        for (const cmd of commands) {
          const started = performance.now();
          child.stdin?.write(`${cmd}\n`);
          await watcher.waitForPrompt();
          latencies.push(performance.now() - started);
        }

        child.stdin?.write('/exit\n');
        child.stdin?.end();

        const exitCode = await new Promise<number | null>((resolveCode) => {
          child.once('close', resolveCode);
        });
        watcher.dispose();
        if (exitCode !== 0) {
          rejectPromise(new Error(`tui benchmark exited with code ${String(exitCode)}`));
          return;
        }
        resolvePromise(latencies);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

function formatStatsTable(name: string, stats: Stats, sampleCount: number): string {
  return [
    `${name} (${sampleCount} samples)`,
    `  min: ${stats.min.toFixed(2)}ms`,
    `  avg: ${stats.avg.toFixed(2)}ms`,
    `  p50: ${stats.p50.toFixed(2)}ms`,
    `  p95: ${stats.p95.toFixed(2)}ms`,
    `  p99: ${stats.p99.toFixed(2)}ms`,
    `  max: ${stats.max.toFixed(2)}ms`,
  ].join('\n');
}

async function main(): Promise<void> {
  const cliEntry = resolveCliEntry();
  const startupSamples: number[] = [];
  const tuiSamples: number[] = [];

  for (let i = 0; i < Math.max(0, STARTUP_WARMUPS); i += 1) {
    await measureCliStartup(cliEntry);
  }

  for (let i = 0; i < Math.max(1, STARTUP_SAMPLES); i += 1) {
    startupSamples.push(await measureCliStartup(cliEntry));
  }

  for (let i = 0; i < Math.max(1, TUI_SESSIONS); i += 1) {
    const one = await measureTuiRefreshSession(cliEntry, TUI_COMMANDS);
    tuiSamples.push(...one);
  }

  const startupStats = summarize(startupSamples);
  const tuiStats = summarize(tuiSamples);

  const out: BenchOutput = {
    generatedAt: new Date().toISOString(),
    cliEntry,
    cliStartup: {
      samples: round(startupSamples),
      stats: roundStats(startupStats),
    },
    tuiRefresh: {
      samples: round(tuiSamples),
      stats: roundStats(tuiStats),
      sessions: Math.max(1, TUI_SESSIONS),
      commandsPerSession: TUI_COMMANDS.length,
      commands: TUI_COMMANDS,
    },
  };

  const reportDir = resolve(
    process.env.CLI_TUI_BENCH_REPORT_DIR ?? 'data/cli-tui-latency-benchmark-reports',
  );
  mkdirSync(reportDir, { recursive: true });
  const jsonPath = resolve(reportDir, 'latest.json');
  const mdPath = resolve(reportDir, 'latest.md');

  writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  writeFileSync(
    mdPath,
    [
      '# CLI + TUI Latency Benchmark',
      '',
      `- generatedAt: ${out.generatedAt}`,
      `- cliEntry: ${out.cliEntry}`,
      `- sessions: ${out.tuiRefresh.sessions}`,
      `- commandsPerSession: ${out.tuiRefresh.commandsPerSession}`,
      '',
      '## CLI startup',
      '',
      formatStatsTable('CLI startup latency', out.cliStartup.stats, out.cliStartup.samples.length),
      '',
      '## TUI refresh',
      '',
      formatStatsTable('TUI refresh latency', out.tuiRefresh.stats, out.tuiRefresh.samples.length),
      '',
      '## Commands',
      ...out.tuiRefresh.commands.map((command) => `- ${command}`),
      '',
      '## Artifacts',
      `- ${jsonPath}`,
      `- ${mdPath}`,
    ].join('\n'),
    'utf8',
  );

  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
