import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Stats = {
  p95: number;
  p99: number;
};

type BenchReport = {
  generatedAt: string;
  cliStartup: { stats: Stats };
  tuiRefresh: { stats: Stats };
};

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function main(): void {
  const reportPath = resolve(
    process.env.CLI_TUI_BENCH_REPORT_JSON ?? 'data/cli-tui-latency-benchmark-reports/latest.json',
  );
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BenchReport;

  const limits = {
    cliP95: readNumberEnv('CLI_TUI_SLO_MAX_CLI_P95_MS', 500),
    cliP99: readNumberEnv('CLI_TUI_SLO_MAX_CLI_P99_MS', 700),
    tuiP95: readNumberEnv('CLI_TUI_SLO_MAX_TUI_P95_MS', 10),
    tuiP99: readNumberEnv('CLI_TUI_SLO_MAX_TUI_P99_MS', 15),
  };

  const checks = [
    {
      name: 'cliStartup.p95',
      value: report.cliStartup.stats.p95,
      limit: limits.cliP95,
    },
    {
      name: 'cliStartup.p99',
      value: report.cliStartup.stats.p99,
      limit: limits.cliP99,
    },
    {
      name: 'tuiRefresh.p95',
      value: report.tuiRefresh.stats.p95,
      limit: limits.tuiP95,
    },
    {
      name: 'tuiRefresh.p99',
      value: report.tuiRefresh.stats.p99,
      limit: limits.tuiP99,
    },
  ];

  const failed = checks.filter((check) => check.value > check.limit);
  const out = {
    ok: failed.length === 0,
    generatedAt: report.generatedAt,
    reportPath,
    checks,
    failed,
    limits,
  };

  console.log(JSON.stringify(out, null, 2));
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
