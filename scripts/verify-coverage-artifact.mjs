import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const summaryPath = resolve(process.cwd(), 'coverage', 'coverage-summary.json');

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`coverage artifact missing or invalid: ${summaryPath}: ${reason}`);
  process.exit(1);
}

const metrics = ['statements', 'branches', 'functions', 'lines'];
for (const metric of metrics) {
  const value = summary?.total?.[metric]?.pct;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    console.error(`coverage artifact missing numeric total.${metric}.pct: ${summaryPath}`);
    process.exit(1);
  }
}

console.log(`coverage artifact verified: ${summaryPath}`);
