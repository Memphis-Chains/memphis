/**
 * `memphis audit-runtime` — one measurement of the live system, with a
 * verdict per check.
 *
 * The name is not `audit` because `audit` is already the governance
 * chain's search (`memphis audit search`). Two commands must not answer
 * to one word; the confusion between "search the audit chain" and
 * "measure the runtime" is exactly the kind this plan exists to remove.
 *
 * EXIT CODES
 *   0  every check measured the live system and it was right
 *   1  at least one check measured the live system and it was wrong
 *   2  nothing failed, but at least one check could not reach the
 *      system it measures — the audit does not know, and says so
 */

import { renderAuditReport, runRuntimeAudit } from '../../audit/runtime-audit.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export async function handleAuditRuntimeCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'audit-runtime') {
    return false;
  }

  const report = await runRuntimeAudit({ rawEnv: process.env, config: context.getConfig() });

  if (context.args.json) {
    print(report, true);
  } else {
    console.log(renderAuditReport(report));
  }

  if (report.failures > 0) {
    process.exitCode = 1;
  } else if (!report.ok) {
    process.exitCode = 2;
  } else {
    process.exitCode = 0;
  }

  return true;
}
