import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const contractFixturePath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'cognitive-report-query',
  'output-contract.json',
);

type OutputContractFixture = {
  schemaVersion: number;
  topLevelKeys: string[];
  watchNdjsonTopLevelKeys: string[];
  reportKeys: string[];
  validTypeFilters: string[];
  reportTypeToDataType: Record<string, string>;
  errorTopLevelKeys: string[];
};

const outputContract = JSON.parse(
  readFileSync(contractFixturePath, 'utf8'),
) as OutputContractFixture;

function runQuery(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('npm', ['run', '-s', 'ops:query-cognitive-reports', '--', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 15_000,
  });
}

async function seedCognitiveReports(dataDir: string): Promise<void> {
  const env = { MEMPHIS_DATA_DIR: dataDir, RUST_CHAIN_ENABLED: 'false' };
  await runCli(['insights', '--json', '--save'], { env });
  await runCli(['categorize', 'Prepare release checklist', '--json', '--save'], { env });
  await runCli(['reflect', '--json', '--save'], { env });
}

describe('cognitive report query script', () => {
  it('returns latest cognitive reports as JSON for ops automation', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'memphis-cognitive-query-'));
    try {
      await seedCognitiveReports(dataDir);

      const result = runQuery(['--json', '--limit', '5'], {
        ...process.env,
        MEMPHIS_DATA_DIR: dataDir,
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        schemaVersion: number;
        ok: boolean;
        typeFilter: string;
        count: number;
        reports: Array<{
          reportType: string;
          dataType: string;
          schemaVersion: number | null;
        }>;
      };
      expect(Object.keys(parsed).sort()).toEqual([...outputContract.topLevelKeys].sort());
      expect(parsed.schemaVersion).toBe(outputContract.schemaVersion);
      expect(parsed.ok).toBe(true);
      expect(outputContract.validTypeFilters.includes(parsed.typeFilter)).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(3);
      expect(new Set(parsed.reports.map((item) => item.reportType))).toEqual(
        new Set(['insight', 'categorize', 'reflection']),
      );
      for (const report of parsed.reports) {
        expect(Object.keys(report).sort()).toEqual([...outputContract.reportKeys].sort());
        expect(report.schemaVersion).toBe(outputContract.schemaVersion);
        expect(report.dataType).toBe(outputContract.reportTypeToDataType[report.reportType] ?? '');
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('supports type filtering for targeted triage', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'memphis-cognitive-query-filter-'));
    try {
      await seedCognitiveReports(dataDir);

      const result = runQuery(['--json', '--type', 'categorize'], {
        ...process.env,
        MEMPHIS_DATA_DIR: dataDir,
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        schemaVersion: number;
        ok: boolean;
        typeFilter: string;
        reports: Array<{ reportType: string; dataType: string }>;
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.typeFilter).toBe('categorize');
      expect(parsed.reports.length).toBeGreaterThan(0);
      expect(parsed.reports.every((item) => item.reportType === 'categorize')).toBe(true);
      expect(parsed.reports.every((item) => item.dataType === 'categorize_report')).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('supports watch mode for live triage output', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'memphis-cognitive-query-watch-'));
    try {
      await seedCognitiveReports(dataDir);
      const result = runQuery(
        ['--watch', '--type', 'categorize', '--limit', '1', '--interval-ms', '20', '--count', '2'],
        { ...process.env, MEMPHIS_DATA_DIR: dataDir },
      );

      expect(result.status).toBe(0);
      expect((result.stdout.match(/\[watch\]/g) ?? []).length).toBe(2);
      expect(result.stdout).toContain('[categorize]');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('supports ndjson watch mode for streaming integrations', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'memphis-cognitive-query-watch-ndjson-'));
    try {
      await seedCognitiveReports(dataDir);
      const result = runQuery(
        [
          '--watch',
          '--ndjson',
          '--type',
          'categorize',
          '--limit',
          '1',
          '--interval-ms',
          '20',
          '--count',
          '2',
        ],
        { ...process.env, MEMPHIS_DATA_DIR: dataDir },
      );

      expect(result.status).toBe(0);
      const lines = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);

      const parsedLines = lines.map(
        (line) =>
          JSON.parse(line) as {
            schemaVersion: number;
            ok: boolean;
            mode: string;
            typeFilter: string;
            iteration: number;
            intervalMs: number;
            watchCount: number | null;
            watchedAt: string;
            reports: Array<{ reportType: string; dataType: string }>;
          },
      );

      for (const [index, item] of parsedLines.entries()) {
        expect(Object.keys(item).sort()).toEqual(
          [...outputContract.watchNdjsonTopLevelKeys].sort(),
        );
        expect(item.schemaVersion).toBe(outputContract.schemaVersion);
        expect(item.ok).toBe(true);
        expect(item.mode).toBe('watch');
        expect(item.typeFilter).toBe('categorize');
        expect(item.iteration).toBe(index + 1);
        expect(item.intervalMs).toBe(20);
        expect(item.watchCount).toBe(2);
        expect(item.watchedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
        expect(item.reports.length).toBeGreaterThan(0);
        expect(item.reports.every((report) => report.reportType === 'categorize')).toBe(true);
        expect(item.reports.every((report) => report.dataType === 'categorize_report')).toBe(true);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('uses stable error contract for invalid arguments', () => {
    const result = runQuery(['--unknown-flag'], process.env);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string };
    expect(Object.keys(parsed).sort()).toEqual([...outputContract.errorTopLevelKeys].sort());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('unknown argument');
  });

  it('rejects invalid output mode combinations with stable error contract', () => {
    const result = runQuery(['--json', '--ndjson'], process.env);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: string };
    expect(Object.keys(parsed).sort()).toEqual([...outputContract.errorTopLevelKeys].sort());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('cannot be combined');

    const ndjsonWithoutWatch = runQuery(['--ndjson'], process.env);
    expect(ndjsonWithoutWatch.status).toBe(1);
    const parsedNdjson = JSON.parse(ndjsonWithoutWatch.stderr) as { ok: boolean; error: string };
    expect(Object.keys(parsedNdjson).sort()).toEqual([...outputContract.errorTopLevelKeys].sort());
    expect(parsedNdjson.ok).toBe(false);
    expect(parsedNdjson.error).toContain('--ndjson requires --watch');
  });
});
