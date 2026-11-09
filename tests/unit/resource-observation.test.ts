import { describe, expect, it } from 'vitest';

import { cpuFromSamples, parseMemoryInfo, parseNvidiaCsv, parsePressure } from '../../src/infra/runtime/resource-observation.js';

describe('homeostat resource observations', () => {
  it('calculates CPU utilization from two host counter samples', () => {
    const result = cpuFromSamples({ total: 100, idle: 80, count: 4 }, { total: 200, idle: 150, count: 4 }, 250);
    expect(result).toEqual({ status: 'observed', source: 'os.cpus', value: { utilizationPercent: 30, sampleMs: 250, logicalCpus: 4 } });
    expect(cpuFromSamples({ total: 200, idle: 150, count: 4 }, { total: 100, idle: 80, count: 4 }, 250).status).toBe('unavailable');
    expect(cpuFromSamples({ total: 100, idle: 80, count: 4 }, { total: 200, idle: 150, count: 3 }, 250).status).toBe('unavailable');
    expect(cpuFromSamples({ total: 100, idle: 80, count: 4 }, { total: NaN, idle: 150, count: 4 }, 250).status).toBe('unavailable');
  });

  it('distinguishes available RAM from swap occupancy and rejects invalid samples', () => {
    const input = 'MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 30 kB\nSwapFree: 20 kB\n';
    expect(parseMemoryInfo(input)).toEqual({ status: 'observed', source: '/proc/meminfo', value: {
      totalBytes: 102400, availableBytes: 40960, swapTotalBytes: 30720, swapUsedBytes: 10240,
    } });
    expect(parseMemoryInfo('MemTotal: 100 kB\n').status).toBe('unavailable');
    expect(parseMemoryInfo('MemTotal: 100 kB\nMemAvailable: 101 kB\n').status).toBe('unavailable');
  });

  it('does not turn invalid or missing pressure samples into zeros', () => {
    expect(parsePressure('some avg10=0.20 avg60=1.50 avg300=0.00 total=2', 'psi')).toMatchObject({
      status: 'observed', value: { someAvg10Percent: 0.2, someAvg60Percent: 1.5 },
    });
    expect(parsePressure('some avg10=bad avg60=1.50', 'psi').status).toBe('unavailable');
    expect(parsePressure('', 'psi').status).toBe('unavailable');
  });

  it('distinguishes unsupported GPU fields from zero and rejects malformed output', () => {
    expect(parseNvidiaCsv('0, Example GPU, 4096, 1024, 25, N/A')).toEqual({ status: 'observed', source: 'nvidia-smi', value: [{
      index: 0, name: 'Example GPU', totalMiB: 4096, usedMiB: 1024, utilizationPercent: 25, temperatureC: null,
    }] });
    expect(parseNvidiaCsv('')).toMatchObject({ status: 'unavailable' });
    expect(parseNvidiaCsv('malformed')).toMatchObject({ status: 'unavailable' });
    expect(parseNvidiaCsv('0, Example GPU, 4096, 1024, 101, 50')).toMatchObject({
      status: 'observed', value: [{ utilizationPercent: null }],
    });
  });
});
