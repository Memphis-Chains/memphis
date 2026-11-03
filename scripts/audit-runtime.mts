/**
 * S0 — the runtime audit, as an operator script.
 *
 * One command that measures the live system and says, per check, whether
 * the thing it measures is right. The spec is
 * `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` §3.1.
 *
 * This is the falsifier for every later stage: a stage is done when the
 * audit's verdict for the hole it closed changes, and the audit itself
 * is only trustworthy if its verdict changes when the SYSTEM changes.
 * That is checked by running it twice against two different states — see
 * `tests/unit/runtime-audit.test.ts` and the mutation note in §3.1.
 *
 * USAGE
 * -----
 *   npm run -s ops:audit           # human-readable
 *   npm run -s ops:audit -- --json # machine-readable
 *
 * EXIT CODES
 *   0  every check measured the live system and it was right
 *   1  at least one check measured the live system and it was wrong
 *   2  nothing failed, but something could not be measured
 */

import { renderAuditReport, runRuntimeAudit } from '../src/infra/audit/runtime-audit.js';

const wantsJson = process.argv.includes('--json');

const report = await runRuntimeAudit({ rawEnv: process.env });

if (wantsJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderAuditReport(report));
}

process.exitCode = report.failures > 0 ? 1 : report.ok ? 0 : 2;
