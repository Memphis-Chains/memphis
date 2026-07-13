import type { DoctorCheckLevel, DoctorReport, DoctorTier } from './doctor-v2.js';
import { doctorTierTitle } from './doctor-v2.js';

function icon(level: DoctorCheckLevel): string {
  return level === 'pass' ? '✓' : level === 'warn' ? '⚠' : '✗';
}

/** Render the stable human-facing doctor report independently of diagnostics. */
export function printDoctorHumanReport(report: DoctorReport): void {
  const border = '═'.repeat(76);
  console.log(`╔${border}╗`);
  console.log(`║ ${`MEMPHIS DOCTOR v2.0 ${report.ok ? 'PASS' : 'FAIL'}`.padEnd(75)}║`);
  console.log(`╚${border}╝`);

  for (const tier of [1, 2, 3, 4, 5, 6, 'A'] as const) {
    const tierChecks = report.checks.filter((check) => check.tier === tier);
    if (tierChecks.length === 0) continue;
    console.log(`\n┌─ ${doctorTierTitle[tier as DoctorTier | 'A']}`);
    for (const check of tierChecks) {
      console.log(`│ ${icon(check.level)} ${check.title}: ${check.detail}`);
      if (check.fix && check.level !== 'pass') console.log(`│   ↳ fix: ${check.fix}`);
    }
  }

  console.log(
    `\nSummary: total=${report.summary.total} pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
  );
  console.log(
    `Repair: status=${report.repairStatus} repairable=${report.repairable ? 'yes' : 'no'} action=${report.recommendedAction}`,
  );
  console.log(`First-run plan: ${report.firstRunPlan.summary} next=${report.firstRunPlan.nextCommand}`);
  if (report.repairs.length > 0) {
    console.log('Repairs applied:');
    for (const repair of report.repairs) console.log(`  - ${repair}`);
  }
}
