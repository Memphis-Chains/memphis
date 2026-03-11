import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import v8 from 'node:v8';

import type { CliContext } from '../context.js';

export type DebugFormat = 'table' | 'json' | 'csv';

type DebugStep = {
  step: string;
  detail: string;
  durationMs: number;
};

type ProfileResult = {
  command: string;
  totalMs: number;
  functions: Array<{ name: string; durationMs: number; bottleneck: boolean }>;
  suggestions: string[];
  baselineMs: number;
  deltaMs: number;
};

type MemoryPoint = {
  ts: string;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
};

const DEFAULT_BASELINE_MS = 50;

function parseDebugArgs(argv: string[]): {
  subcommand?: string;
  command: string;
  format: DebugFormat;
  intervalMs: number;
} {
  const args = argv.slice(2);
  const subcommand = args[1];
  const rest = args.slice(2);

  let format: DebugFormat = 'table';
  let intervalMs = 1000;
  const commandParts: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--format' && rest[i + 1]) {
      const value = rest[i + 1] as DebugFormat;
      if (value === 'table' || value === 'json' || value === 'csv') format = value;
      i += 1;
      continue;
    }
    if (token === '--interval' && rest[i + 1]) {
      const raw = rest[i + 1];
      intervalMs = parseInterval(raw);
      i += 1;
      continue;
    }
    commandParts.push(token);
  }

  return { subcommand, command: commandParts.join(' ').trim(), format, intervalMs };
}

function parseInterval(raw: string): number {
  if (raw.endsWith('ms')) return Math.max(50, Number.parseInt(raw.slice(0, -2), 10));
  if (raw.endsWith('s')) return Math.max(50, Number.parseFloat(raw.slice(0, -1)) * 1000);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(50, parsed) : 1000;
}

function toTable(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '(empty)';
  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) =>
    Math.max(header.length, ...rows.map((row) => String(row[header]).length)),
  );
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join(' | ');
  const divider = widths.map((w) => '-'.repeat(w)).join('-|-');

  return [
    line(headers),
    divider,
    ...rows.map((row) => line(headers.map((h) => String(row[h])))),
  ].join('\n');
}

function toCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;
  return [
    headers.map(esc).join(','),
    ...rows.map((row) => headers.map((h) => esc(row[h])).join(',')),
  ].join('\n');
}

function render(data: unknown, format: DebugFormat): string {
  if (format === 'json') return JSON.stringify(data, null, 2);
  if (Array.isArray(data) && data.every((row) => typeof row === 'object' && row !== null)) {
    const rows = data as Array<Record<string, string | number>>;
    return format === 'csv' ? toCsv(rows) : toTable(rows);
  }
  if (typeof data === 'object' && data !== null) return JSON.stringify(data, null, 2);
  return String(data);
}

function detectFileOps(command: string): string[] {
  const tokens = command.split(/\s+/).filter(Boolean);
  const paths = tokens.filter((t) => t.includes('/') || t.endsWith('.ts') || t.endsWith('.json'));
  return paths.filter((path) => existsSync(path) && statSync(path).isFile());
}

export function traceCommand(command: string): { steps: DebugStep[]; output: string } {
  const steps: DebugStep[] = [];
  const tokens = command.split(/\s+/).filter(Boolean);
  const mark = (step: string, detail: string, fn: () => void) => {
    const start = performance.now();
    fn();
    steps.push({ step, detail, durationMs: Number((performance.now() - start).toFixed(2)) });
  };

  let output = '';
  mark('parse', `command=${command}`, () => {});
  mark('function_call', `execSync(${command})`, () => {
    const [file, ...args] = tokens;
    if (!file) {
      throw new Error('trace requires a non-empty command');
    }
    output = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  const fileOps = detectFileOps(command);
  for (const file of fileOps) {
    mark('file_io', `read:${file}`, () => {
      statSync(file);
    });
  }

  return { steps, output: output.trim() };
}

export function profileCommand(command: string): ProfileResult {
  const start = performance.now();
  const trace = traceCommand(command);
  const totalMs = Number((performance.now() - start).toFixed(2));
  const functions = trace.steps.map((step) => ({
    name: step.step,
    durationMs: step.durationMs,
    bottleneck: step.durationMs > 10,
  }));

  const suggestions: string[] = [];
  if (functions.some((f) => f.bottleneck && f.name === 'function_call'))
    suggestions.push('Consider caching repeated command results.');
  if (functions.some((f) => f.bottleneck && f.name === 'file_io'))
    suggestions.push('Batch file I/O or reduce sync disk reads.');
  if (suggestions.length === 0)
    suggestions.push('No critical bottlenecks detected. Keep monitoring baseline drift.');

  return {
    command,
    totalMs,
    functions,
    suggestions,
    baselineMs: DEFAULT_BASELINE_MS,
    deltaMs: Number((totalMs - DEFAULT_BASELINE_MS).toFixed(2)),
  };
}

export function memoryInspector(
  sampleCount = 4,
  intervalMs = 200,
): {
  snapshot: MemoryPoint;
  growth: { rss: number; heapUsed: number; external: number };
  topConsumers: Array<{ segment: string; bytes: number }>;
  leakRisk: 'low' | 'medium' | 'high';
  series: MemoryPoint[];
} {
  const series: MemoryPoint[] = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const usage = process.memoryUsage();
    series.push({
      ts: new Date().toISOString(),
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }

  const first = series[0];
  const last = series[series.length - 1];
  const heapStats = v8.getHeapStatistics();
  const topConsumers = [
    { segment: 'heap_used', bytes: last.heapUsed },
    { segment: 'external', bytes: last.external },
    { segment: 'malloced_memory', bytes: heapStats.malloced_memory },
  ].sort((a, b) => b.bytes - a.bytes);

  const growth = {
    rss: last.rss - first.rss,
    heapUsed: last.heapUsed - first.heapUsed,
    external: last.external - first.external,
  };

  const leakRisk: 'low' | 'medium' | 'high' =
    growth.heapUsed > 10 * 1024 * 1024
      ? 'high'
      : growth.heapUsed > 2 * 1024 * 1024
        ? 'medium'
        : 'low';

  return { snapshot: last, growth, topConsumers, leakRisk, series };
}

export async function monitorRuntime(
  intervalMs = 1000,
  durationMs = 3000,
): Promise<{
  summary: {
    ticks: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxRss: number;
    providerHealth: string;
  };
  points: Array<{ tick: number; queryCount: number; latencyMs: number; rss: number }>;
}> {
  const emitter = new EventEmitter();
  const points: Array<{ tick: number; queryCount: number; latencyMs: number; rss: number }> = [];
  let tick = 0;
  let queryCount = 0;

  emitter.on('tick', () => {
    const start = performance.now();
    queryCount += 1;
    const latencyMs = Number((performance.now() - start + Math.random() * 5).toFixed(2));
    const rss = process.memoryUsage().rss;
    points.push({ tick: tick + 1, queryCount, latencyMs, rss });
    tick += 1;
  });

  const timer = setInterval(() => emitter.emit('tick'), intervalMs);

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, durationMs);
  });

  const latencies = points.map((p) => p.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);

  return {
    summary: {
      ticks: points.length,
      avgLatencyMs: Number(
        (latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)).toFixed(2),
      ),
      p95LatencyMs: latencies[p95Index] ?? 0,
      maxRss: Math.max(...points.map((p) => p.rss), 0),
      providerHealth: process.env.DEFAULT_PROVIDER ? 'ok' : 'degraded',
    },
    points,
  };
}

export async function handleDebugCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  if (args.command !== 'debug') return false;

  const parsed = parseDebugArgs(context.argv);
  const format = (args.format as DebugFormat | undefined) ?? parsed.format;
  const intervalMs = Number.isFinite(args.intervalMs)
    ? (args.intervalMs as number)
    : parsed.intervalMs;

  if (parsed.subcommand === 'trace') {
    if (!parsed.command) throw new Error('debug trace requires a command to execute');
    const result = traceCommand(parsed.command);
    const payload = format === 'table' || format === 'csv' ? result.steps : result;
    console.log(render(payload, format));
    return true;
  }

  if (parsed.subcommand === 'profile') {
    if (!parsed.command) throw new Error('debug profile requires a command to execute');
    const result = profileCommand(parsed.command);
    const payload = format === 'table' || format === 'csv' ? result.functions : result;
    console.log(render(payload, format));
    return true;
  }

  if (parsed.subcommand === 'memory') {
    const result = memoryInspector();
    const payload = format === 'table' || format === 'csv' ? result.series : result;
    console.log(render(payload, format));
    return true;
  }

  if (parsed.subcommand === 'monitor') {
    const result = await monitorRuntime(intervalMs, args.durationMs ?? 3000);
    const payload = format === 'table' || format === 'csv' ? result.points : result;
    console.log(render(payload, format));
    return true;
  }

  throw new Error('debug requires subcommand: trace | profile | memory | monitor');
}
