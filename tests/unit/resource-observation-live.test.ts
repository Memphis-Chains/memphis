/**
 * Live orchestration tests for the host resource observations.
 *
 * The pure parsers are covered in `resource-observation.test.ts`. This file
 * covers the part that was not: the orchestrator that actually reaches the
 * host, and the shape contract the tool publishes.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Measured 2026-11-09 on the operator's host: the four parsers had 15
 * assertions, and `observeResources` itself had NONE. Three mutations of the
 * orchestrator therefore passed every green gate in the repository:
 *
 *   - dropping `resources` from the tool output entirely;
 *   - reporting the GPU as unavailable no matter what `nvidia-smi` said;
 *   - reporting the data filesystem as observed even when it could not be
 *     read.
 *
 * Each of those is a silent lie: the tool would claim it measured the host
 * while the measurement never happened. The assertions below kill all three,
 * plus the class where an unavailable observation carries a zero value.
 *
 * The GPU is exercised through a real `nvidia-smi` shim on PATH rather than
 * a module mock, so the spawn, the argument vector and the CSV parse are all
 * on the tested path. The macOS CI runner has no NVIDIA hardware; the shim
 * makes the outcome identical there and on the operator's host.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cpuFromSamples,
  observeResources,
  parseMemoryInfo,
  parseNvidiaCsv,
  parsePressure,
  type ResourceObservation,
} from '../../src/infra/runtime/resource-observation.js';

type AnyObservation = { status: string; source: string; value?: unknown; reason?: string };

function observationsOf(result: ResourceObservation): AnyObservation[] {
  return [
    result.cpu,
    result.memory,
    result.dataFilesystem,
    result.pressure.cpu,
    result.pressure.memory,
    result.pressure.io,
    result.gpu,
  ];
}

function shimDirectory(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-resource-observation-'));
  const binary = join(dir, 'nvidia-smi');
  writeFileSync(binary, script, { mode: 0o755 });
  chmodSync(binary, 0o755);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('host resource observations — live orchestration', () => {
  it('publishes every observation as observed or unavailable, never as a silent zero', async () => {
    const result = await observeResources({ MEMPHIS_DATA_DIR: tmpdir() });
    const observations = observationsOf(result);
    expect(observations).toHaveLength(7);
    for (const observation of observations) {
      expect(['observed', 'unavailable']).toContain(observation.status);
      expect(observation.source.length).toBeGreaterThan(0);
      if (observation.status === 'observed') {
        // An observation that claims to have measured must carry the value.
        expect(observation.value, `observed ${observation.source} has no value`).toBeDefined();
        expect(observation.reason).toBeUndefined();
      } else {
        // The whole point of `unavailable`: the absence of a measurement is
        // never rendered as a zero, which would read as "measured, and the
        // answer was zero".
        expect(observation.reason, `unavailable ${observation.source} has no reason`).toBeTruthy();
        expect(
          observation.value,
          `unavailable ${observation.source} carries a value`,
        ).toBeUndefined();
      }
    }
  });

  it('reads GPU telemetry through nvidia-smi when the binary answers', async () => {
    // The shim refuses to answer unless it is asked for the full field set.
    // A real `nvidia-smi` errors on an unknown query field, and a shim that
    // ignored its arguments would let a truncated query pass unnoticed.
    const dir = shimDirectory(
      [
        '#!/bin/sh',
        // Only the query field list is validated; the format flags are legal.
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --query-gpu=*)',
        '    query="$arg"',
        '    for field in index name memory.total memory.used utilization.gpu temperature.gpu; do',
        '      case "$query" in',
        '        *"$field"*) ;;',
        '        *) echo "unknown query field: $field" >&2; exit 1 ;;',
        '      esac',
        '    done',
        '    ;;',
        '  esac',
        'done',
        'echo "0, FAKE GPU, 4096, 1024, 25, 40"',
        '',
      ].join('\n'),
    );
    vi.stubEnv('PATH', `${dir}:${process.env.PATH ?? ''}`);
    const result = await observeResources({ MEMPHIS_DATA_DIR: tmpdir() });
    expect(result.gpu.status).toBe('observed');
    if (result.gpu.status !== 'observed') return;
    expect(result.gpu.value).toEqual([
      {
        index: 0,
        name: 'FAKE GPU',
        totalMiB: 4096,
        usedMiB: 1024,
        utilizationPercent: 25,
        temperatureC: 40,
      },
    ]);
  });

  it('reports the GPU as unavailable when nvidia-smi cannot be executed', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'memphis-resource-observation-empty-'));
    vi.stubEnv('PATH', empty);
    const result = await observeResources({ MEMPHIS_DATA_DIR: tmpdir() });
    expect(result.gpu.status).toBe('unavailable');
    if (result.gpu.status !== 'unavailable') return;
    // The reason has to say that the ABSENCE OF TELEMETRY was not read as
    // the absence of a GPU.
    expect(result.gpu.reason).toContain('GPU absence is not established');
    expect(result.gpu.value).toBeUndefined();
  });

  it('reports the data filesystem as unavailable when the data directory cannot be read', async () => {
    const result = await observeResources({ MEMPHIS_DATA_DIR: '/nonexistent-memphis-data-dir' });
    expect(result.dataFilesystem.status).toBe('unavailable');
    if (result.dataFilesystem.status !== 'unavailable') return;
    expect(result.dataFilesystem.reason).toBeTruthy();
    expect(result.dataFilesystem.value).toBeUndefined();
  });

  it('reports the data filesystem when the data directory can be read', async () => {
    const result = await observeResources({ MEMPHIS_DATA_DIR: tmpdir() });
    expect(result.dataFilesystem.status).toBe('observed');
    if (result.dataFilesystem.status !== 'observed') return;
    expect(result.dataFilesystem.value.totalBytes).toBeGreaterThan(0);
    expect(result.dataFilesystem.value.availableBytes).toBeGreaterThan(0);
  });

  it('never renders an unavailable measurement as a zero', () => {
    // The shape contract, checked on every failure branch of every parser.
    // The live pass above cannot reach these branches on a healthy host, so
    // without this the "unavailable carries a value" mutation survives.
    const failures = [
      parseMemoryInfo('MemTotal: 100 kB\n'),
      parseMemoryInfo('MemTotal: 100 kB\nMemAvailable: 101 kB\n'),
      parsePressure('some avg10=bad avg60=1.50', 'psi'),
      parsePressure('', 'psi'),
      parseNvidiaCsv('malformed'),
      parseNvidiaCsv(''),
      cpuFromSamples({ total: 100, idle: 80, count: 4 }, { total: 100, idle: 150, count: 4 }, 250),
    ];
    for (const failure of failures) {
      expect(failure.status).toBe('unavailable');
      if (failure.status !== 'unavailable') continue;
      expect(failure.reason, `unavailable ${failure.source} has no reason`).toBeTruthy();
      expect(failure.value, `unavailable ${failure.source} carries a value`).toBeUndefined();
    }
  });

  it('never throws when the data directory is missing', async () => {
    await expect(
      observeResources({ MEMPHIS_DATA_DIR: '/nonexistent-memphis-data-dir' }),
    ).resolves.toBeDefined();
  });

  it('declares what the measurement is and is not', async () => {
    const result = await observeResources({ MEMPHIS_DATA_DIR: tmpdir() });
    expect(result.purpose).toBe('instantaneous-observation');
    expect(result.scope).toBe('host-observation-not-cgroup-limit');
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
    expect(Date.parse(result.observedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    if (result.cpu.status === 'observed') {
      expect(result.cpu.value.logicalCpus).toBeGreaterThanOrEqual(1);
      expect(result.cpu.value.utilizationPercent).toBeGreaterThanOrEqual(0);
      expect(result.cpu.value.utilizationPercent).toBeLessThanOrEqual(100);
    }
  });
});
