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

import { listUnitsUnderTest, type UnitUnderTest } from '../src/infra/audit/systemd-unit-scope.js';

const REPO_ROOT = resolve('.');

/**
 * Units that stay up for a long time and therefore must be bounded.
 *
 * The runtime's own cgroup peaked at 3.4 GB and the app slice at 9.6 GB
 * with 1.4 GB of swap, with no limit anywhere above it. A memory cap
 * turns that into a restart the operator can see.
 */
const LONG_RUNNING_SERVICES = new Set(['memphis.service']);

interface Finding {
  file: string;
  problem: string;
}

function readUnit(unit: UnitUnderTest): string {
  return readFileSync(unit.path, 'utf8');
}

/**
 * Directives inside [Service]. A unit may declare ExecStart=, ExecStartPre=,
 * ExecStop= or ExecStopPost= — systemd accepts any of them as proof that
 * the unit has something to run. The stub had none of them.
 */
function hasRunnableDirective(src: string): boolean {
  return /^\s*Exec(Start|Stop)\w*\s*=/m.test(src);
}

function onFailureTargets(src: string): string[] {
  const targets: string[] = [];
  for (const match of src.matchAll(/^\s*OnFailure\s*=\s*(\S+)/gm)) {
    targets.push(match[1]);
  }
  return targets;
}

const units = listUnitsUnderTest(REPO_ROOT);
const findings: Finding[] = [];

for (const unit of units) {
  const file = unit.file;
  if (!file.endsWith('.service')) continue;
  const src = readUnit(unit);

  if (!hasRunnableDirective(src)) {
    findings.push({
      file,
      problem:
        'no ExecStart=/ExecStop= — systemd refuses to run this unit with ' +
        '"Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing."',
    });
  }

  for (const target of onFailureTargets(src)) {
    // Only local unit names are checked; a template or a remote target
    // (e.g. user@.service) is out of scope for this gate.
    if (!target.endsWith('.service')) continue;
    if (target.includes('@')) continue;

    const targetUnit = units.find((candidate) => candidate.name === target);
    if (!targetUnit) {
      findings.push({
        file,
        problem: `OnFailure= points at ${target}, which is not one of the shipped units`,
      });
      continue;
    }

    const targetSrc = readUnit(targetUnit);
    if (!hasRunnableDirective(targetSrc)) {
      findings.push({
        file,
        problem: `OnFailure= points at ${target}, which has no ExecStart= — the failure would be reported into the void`,
      });
    }
  }

  // A long-running service with no memory ceiling lets the kernel OOM
  // killer act instead of the supervisor. The operator then sees the
  // runtime die with no visible cause — which is exactly what happened
  // here: 9.6 GB across the app slice, 1.4 GB of swap, no limit above
  // it.
  if (LONG_RUNNING_SERVICES.has(unit.name) && !/^\s*MemoryMax\s*=\s*\S/m.test(src)) {
    findings.push({
      file,
      problem:
        'no MemoryMax= — a memory leak is stopped by the kernel OOM killer ' +
        'instead of by the supervisor, and the failure has no visible cause',
    });
  }
}

if (findings.length > 0) {
  console.error('systemd unit gate FAILED\n');
  for (const f of findings) {
    console.error(`  ${f.file}: ${f.problem}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`systemd unit gate OK — ${units.length} unit files checked, every .service is runnable`);
