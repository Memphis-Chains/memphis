/**
 * Systemd unit gate — does every shipped .service actually have an ExecStart?
 *
 * WHY THIS EXISTS
 * ---------------
 * Two units shipped as a 71-byte stub:
 *
 *     [Unit]
 *     Description=Alert operator: memphis-monday-admin.service failed
 *
 * No [Service] section, therefore no ExecStart, therefore systemd refused to
 * run them on every boot:
 *
 *     Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.
 *
 * The OnFailure= wiring in the parent units was correct all along. The
 * alert side was missing, so the operator was never told that the Monday
 * or the Tuesday digest failed — and the failure was silent in exactly the
 * direction that matters: the units whose whole job was to report a
 * failure could not report one.
 *
 * WHY A GATE AND NOT JUST THE FIX
 * --------------------------------
 * The fix restores two ExecStart lines. Nothing in the repo would have
 * caught the regression that produced them, and nothing would catch the
 * next one — a new stub unit is the easiest possible unit to write and
 * the easiest possible unit to get wrong. This check is the difference
 * between "the two known units are fixed" and "the class cannot recur".
 *
 * It also checks the second half of the contract: a unit that declares
 * OnFailure= must point at an alert unit that exists, and that alert unit
 * must be able to run. A dangling OnFailure= target is the same defect
 * wearing a different hat — the failure is reported into the void.
 *
 * WHAT IS FLAGGED
 * ---------------
 *   - a .service with no ExecStart= (systemd will refuse to run it)
 *   - an OnFailure= target that does not exist as a unit file
 *   - an OnFailure= target that is itself a stub (no ExecStart=)
 *   - a long-running service with no MemoryMax= (the kernel OOM killer
 *     becomes the supervisor, and the failure has no visible cause)
 *   - a long-running service that is not Restart=always (a clean exit —
 *     the runtime's ordinary drain — leaves the unit down, silently)
 *   - a long-running service with no start-limit pair in [Unit] (the
 *     systemd default, 5 restarts in 10 s, is not the cap)
 *   - a unit of the local family whose supervision policy differs from
 *     the one owner (src/infra/runtime/service-unit-policy.ts)
 *
 * THE UNIT THE GENERATOR WOULD WRITE
 * -----------------------------------
 * MEASURED 2026-11-25 on the operator's host, while closing postmortem
 * item A4: the unit that was RUNNING said `Restart=always` and carried a
 * 4 GB ceiling, while `buildUserServiceUnit` — the function
 * `memphis service install` deploys — said `Restart=on-failure` and
 * carried no ceiling at all. The gate read only files, so it passed: the
 * drift was invisible because the gate was looking somewhere else.
 *
 * So the gate now renders that unit too and holds it to the same rules.
 * The rules themselves live in `src/infra/audit/systemd-unit-rules.ts` —
 * one owner, read by this gate and by the contract corpus.
 *
 * SCOPE
 * -----
 * The first version of this gate read `scripts/systemd/` only. That left
 * `ops/memphis.service` — a second, different unit for the same runtime —
 * unchecked, which the runtime audit reported as an open finding.
 *
 * The roots this gate reads live in `src/infra/audit/systemd-unit-scope.ts`,
 * because the audit that polices this gate has to know the same list. Two
 * readers, one list — otherwise the audit compares a file name against a
 * directory path and reports a hole that was closed months ago.
 *
 * Run: `npm run -s ops:check-systemd-units`
 * Hook: .githooks/pre-commit runs it on staged changes to unit files.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  findUnitFindings,
  GENERATED_UNIT_FILE,
  type UnitRuleFinding,
} from '../src/infra/audit/systemd-unit-rules.js';
import { listUnitsUnderTest, type UnitUnderTest } from '../src/infra/audit/systemd-unit-scope.js';
import { buildUserServiceUnit } from '../src/infra/runtime/user-service.js';

const REPO_ROOT = resolve('.');

function readUnit(unit: UnitUnderTest): string {
  return readFileSync(unit.path, 'utf8');
}

const units = listUnitsUnderTest(REPO_ROOT);
const knownUnitNames = units.map((unit) => unit.name);
const knownUnitSources = new Map<string, string>(units.map((unit) => [unit.name, readUnit(unit)]));

const findings: UnitRuleFinding[] = [];

for (const unit of units) {
  findings.push(
    ...findUnitFindings({
      file: unit.file,
      name: unit.name,
      src: readUnit(unit),
      knownUnitNames,
      knownUnitSources,
    }),
  );
}

// The unit `memphis service install` would write. It is rendered from the
// repository root, so the paths in it are the repository's own — the
// rules do not care where the runtime lives, only what the unit says.
//
// If it cannot be rendered (no entrypoint at all), that is itself a
// finding: a generator that cannot produce a unit is a generator whose
// policy nobody can check.
let generatedUnit: string | null = null;
try {
  generatedUnit = buildUserServiceUnit(REPO_ROOT, {
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
  });
} catch (error) {
  findings.push({
    rule: 'no-runnable-directive',
    file: GENERATED_UNIT_FILE,
    problem: `the generated unit could not be rendered: ${
      error instanceof Error ? error.message : String(error)
    }`,
  });
}

if (generatedUnit !== null) {
  findings.push(
    ...findUnitFindings({
      file: GENERATED_UNIT_FILE,
      name: 'memphis.service',
      src: generatedUnit,
      knownUnitNames,
      knownUnitSources,
    }),
  );
}

if (findings.length > 0) {
  console.error('systemd unit gate FAILED\n');
  for (const f of findings) {
    console.error(`  ${f.file} [${f.rule}]: ${f.problem}`);
  }
  console.error('');
  process.exit(1);
}

console.log(
  `systemd unit gate OK — ${units.length} unit files checked + the generated unit, every .service is runnable`,
);
