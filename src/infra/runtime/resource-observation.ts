/** Read-only, instantaneous host observations. These are not SLO verdicts. */
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

import { getDataDir } from '../../config/paths.js';

const runFile = promisify(execFile);
type Observation<T> = { status: 'observed'; source: string; value: T } |
  { status: 'unavailable'; source: string; reason: string };

export type ResourceObservation = {
  startedAt: string;
  observedAt: string;
  purpose: 'instantaneous-observation';
  scope: 'host-observation-not-cgroup-limit';
  cpu: Observation<{ utilizationPercent: number; sampleMs: number; logicalCpus: number }>;
  memory: Observation<{ totalBytes: number; availableBytes: number; swapTotalBytes?: number; swapUsedBytes?: number }>;
  dataFilesystem: Observation<{ totalBytes: number; availableBytes: number; totalInodes?: number; availableInodes?: number }>;
  pressure: Record<'cpu' | 'memory' | 'io', Observation<{ someAvg10Percent: number; someAvg60Percent: number }>>;
  gpu: Observation<Array<{ index: number; name: string; totalMiB: number | null; usedMiB: number | null; utilizationPercent: number | null; temperatureC: number | null }>>;
};

function unavailable(source: string, reason: string): Observation<never> {
  return { status: 'unavailable', source, reason };
}

export function parseMemoryInfo(text: string): ResourceObservation['memory'] {
  const numbers = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) numbers.set(match[1], Number(match[2]) * 1024);
  }
  const total = numbers.get('MemTotal'); const available = numbers.get('MemAvailable');
  if (total === undefined || available === undefined || !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(available) || total <= 0 || available > total) {
    return unavailable('/proc/meminfo', 'memory fields missing or invalid');
  }
  const swapTotal = numbers.get('SwapTotal'); const swapFree = numbers.get('SwapFree');
  const swap = swapTotal !== undefined && swapFree !== undefined && Number.isSafeInteger(swapTotal) &&
    Number.isSafeInteger(swapFree) && swapFree <= swapTotal
    ? { swapTotalBytes: swapTotal, swapUsedBytes: swapTotal - swapFree } : {};
  return { status: 'observed', source: '/proc/meminfo', value: { totalBytes: total, availableBytes: available, ...swap } };
}

export function parsePressure(text: string, source: string): ResourceObservation['pressure']['cpu'] {
  const line = text.split('\n').find((item) => item.startsWith('some '));
  const fields = Object.fromEntries((line?.split(/\s+/).slice(1) ?? []).map((item) => item.split('=', 2)));
  const a = Number(fields.avg10); const b = Number(fields.avg60);
  if (!line || !fields.avg10 || !fields.avg60 || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 100 || b < 0 || b > 100) {
    return unavailable(source, 'pressure fields missing or invalid');
  }
  return { status: 'observed', source, value: { someAvg10Percent: a, someAvg60Percent: b } };
}

type CpuTotals = { total: number; idle: number; count: number };
function cpuTotals(): CpuTotals {
  const cpus = os.cpus();
  return { total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
    idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0), count: cpus.length };
}

export function cpuFromSamples(first: CpuTotals, last: CpuTotals, sampleMs: number): ResourceObservation['cpu'] {
  const total = last.total - first.total; const idle = last.idle - first.idle;
  if (![first.total, first.idle, first.count, last.total, last.idle, last.count, sampleMs].every(Number.isFinite) ||
      !Number.isInteger(first.count) || first.count < 1 || first.count !== last.count ||
      total <= 0 || idle < 0 || idle > total || sampleMs <= 0) {
    return unavailable('os.cpus', 'invalid or reset CPU counters');
  }
  return { status: 'observed', source: 'os.cpus', value: {
    utilizationPercent: Math.round((total - idle) * 10000 / total) / 100, sampleMs, logicalCpus: last.count,
  } };
}

export function parseNvidiaCsv(text: string): ResourceObservation['gpu'] {
  const rows = text.trim().split('\n').filter(Boolean); const devices: Extract<ResourceObservation['gpu'], {status:'observed'}>['value'] = [];
  const numeric = (v: string): number | null => {
    if (!/^\d+(?:\.\d+)?$/.test(v)) return null;
    const n = Number(v); return Number.isFinite(n) ? n : null;
  };
  for (const row of rows) {
    const values = row.split(',').map((value) => value.trim());
    if (values.length !== 6 || !/^\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0])) || !values[1]) {
      return unavailable('nvidia-smi', 'invalid GPU output');
    }
    const utilization = numeric(values[4]);
    devices.push({ index: Number(values[0]), name: values[1], totalMiB: numeric(values[2]), usedMiB: numeric(values[3]),
      utilizationPercent: utilization !== null && utilization <= 100 ? utilization : null, temperatureC: numeric(values[5]) });
  }
  return devices.length ? { status: 'observed', source: 'nvidia-smi', value: devices }
    : unavailable('nvidia-smi', 'no GPU data returned');
}

async function filesystem(path: string): Promise<ResourceObservation['dataFilesystem']> {
  try {
    const s = await statfs(path, { bigint: true });
    const values = [s.blocks * s.bsize, s.bavail * s.bsize, s.files, s.ffree].map(Number);
    if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid filesystem counters');
    return { status: 'observed', source: 'statfs(data directory)', value: {
      totalBytes: values[0], availableBytes: values[1], ...(values[2] > 0 ? { totalInodes: values[2], availableInodes: values[3] } : {}),
    } };
  } catch { return unavailable('statfs(data directory)', 'filesystem unavailable or invalid'); }
}

async function memory(): Promise<ResourceObservation['memory']> {
  if (process.platform !== 'linux') return unavailable('/proc/meminfo', 'host memory-availability source unsupported');
  try { return parseMemoryInfo(await readFile('/proc/meminfo', 'utf8')); }
  catch { return unavailable('/proc/meminfo', 'host memory data unavailable'); }
}

async function psi(kind: 'cpu' | 'memory' | 'io'): Promise<ResourceObservation['pressure']['cpu']> {
  const source = `/proc/pressure/${kind}`;
  try { return parsePressure(await readFile(source, 'utf8'), source); }
  catch { return unavailable(source, 'pressure data unavailable'); }
}

async function gpu(): Promise<ResourceObservation['gpu']> {
  try {
    const result = await runFile('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits'], { timeout: 1500, maxBuffer: 32_768, windowsHide: true });
    return parseNvidiaCsv(result.stdout);
  } catch { return unavailable('nvidia-smi', 'NVIDIA telemetry unavailable; GPU absence is not established'); }
}

export async function observeResources(rawEnv: NodeJS.ProcessEnv = process.env): Promise<ResourceObservation> {
  const startedAt = new Date().toISOString();
  let first: CpuTotals | undefined;
  try { first = cpuTotals(); } catch { /* CPU telemetry is optional. */ }
  let disk: Promise<ResourceObservation['dataFilesystem']>;
  try { disk = filesystem(getDataDir(rawEnv)); }
  catch { disk = Promise.resolve(unavailable('statfs(data directory)', 'data directory unavailable')); }
  const start = performance.now();
  const other = Promise.all([memory(), disk, psi('cpu'), psi('memory'), psi('io'), gpu()] as const);
  await new Promise((resolve) => setTimeout(resolve, 250));
  let cpu: ResourceObservation['cpu'] = unavailable('os.cpus', 'CPU counters unavailable');
  try { if (first) cpu = cpuFromSamples(first, cpuTotals(), Math.round(performance.now() - start)); }
  catch { /* CPU telemetry is optional. */ }
  const [mem, dataFilesystem, cpuPressure, memoryPressure, ioPressure, graphics] = await other;
  return { startedAt, observedAt: new Date().toISOString(), purpose: 'instantaneous-observation',
    scope: 'host-observation-not-cgroup-limit', cpu, memory: mem, dataFilesystem,
    pressure: { cpu: cpuPressure, memory: memoryPressure, io: ioPressure }, gpu: graphics };
}
