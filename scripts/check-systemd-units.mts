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
 *
 * Run: `npm run -s ops:check-systemd-units`
 * Hook: .githooks/pre-commit runs it on staged changes to unit files.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const UNIT_DIR = resolve('scripts/systemd');

interface Finding {
  file: string;
  problem: string;
}

function listUnitFiles(): string[] {
  if (!existsSync(UNIT_DIR)) {
    throw new Error(`unit directory not found: ${UNIT_DIR}`);
  }
  return readdirSync(UNIT_DIR).filter((f) => f.endsWith('.service') || f.endsWith('.timer'));
}

function readUnit(file: string): string {
  return readFileSync(resolve(UNIT_DIR, file), 'utf8');
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

const files = listUnitFiles();
const findings: Finding[] = [];

for (const file of files) {
  if (!file.endsWith('.service')) continue;
  const src = readUnit(file);

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

    const targetFile = target;
    if (!files.includes(targetFile)) {
      findings.push({
        file,
        problem: `OnFailure= points at ${targetFile}, which does not exist in scripts/systemd/`,
      });
      continue;
    }

    const targetSrc = readUnit(targetFile);
    if (!hasRunnableDirective(targetSrc)) {
      findings.push({
        file,
        problem: `OnFailure= points at ${targetFile}, which has no ExecStart= — the failure would be reported into the void`,
      });
    }
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

console.log(`systemd unit gate OK — ${files.length} unit files checked, every .service is runnable`);
