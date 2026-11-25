/**
 * The rules every shipped systemd unit must satisfy — ONE owner.
 *
 * WHY THIS MODULE EXISTS
 * -----------------------
 * The gate (`scripts/check-systemd-units.mts`) grew its rules inline,
 * one `if` at a time, each with its own paragraph explaining the incident
 * that produced it. That is fine until the same rule has to be applied to
 * a unit that is not a FILE.
 *
 * And it had to be: MEASURED 2026-11-25 on the operator's host, while
 * closing postmortem item A4. The unit that was RUNNING said
 * `Restart=always`; the generator that writes a unit
 * (`buildUserServiceUnit`) said `Restart=on-failure` and carried no
 * memory ceiling at all. The gate read only files, so it passed — the
 * drift was invisible because the gate was looking somewhere else.
 *
 * `Restart=always` is the MEASURED fix: the runtime's ordinary stop is a
 * clean drain that exits 0, and `on-failure` reads that as "nothing went
 * wrong" and leaves the unit DOWN. Running `memphis service install`
 * would have brought the defect back with nothing to say so.
 *
 * THE RULE
 * --------
 * The rules live here as a pure function over unit text. Two runners read
 * them: the gate (over every shipped unit AND over the unit the
 * generator would write) and the contract test (over a corpus of cases).
 * A rule that is not reachable from both is a rule that will be forgotten
 * by one of them.
 */

import { SERVICE_UNIT_POLICY_DIRECTIVES } from '../runtime/service-unit-policy.js';

/**
 * The policy directives that belong to `[Service]`.
 *
 * The start-limit pair is excluded: it belongs to `[Unit]`, and the rule
 * that watches it there has its own name.
 */
const SERVICE_POLICY_SERVICE_DIRECTIVES: ReadonlySet<string> = new Set(
  SERVICE_UNIT_POLICY_DIRECTIVES.map(([directive]) => directive).filter(
    (directive) => directive !== 'StartLimitBurst' && directive !== 'StartLimitIntervalSec',
  ),
);

/** A rule that fired, and what it means for the operator. */
export interface UnitRuleFinding {
  /** The rule's stable name — the corpus and the gate both speak it. */
  rule:
    | 'no-runnable-directive'
    | 'dangling-onfailure'
    | 'stub-onfailure-target'
    | 'no-memory-max'
    | 'not-restart-always'
    | 'no-start-limit'
    | 'start-limit-in-service-section'
    | 'policy-directive-in-unit-section'
    | 'policy-mismatch';
  /** The file the finding is about. */
  file: string;
  /** What is wrong, in the operator's words. */
  problem: string;
}

/**
 * Units that stay up for a long time and therefore must be bounded.
 *
 * The runtime's own cgroup peaked at 3.4 GB and the app slice at 9.6 GB
 * with 1.4 GB of swap, with no limit anywhere above it. A memory cap
 * turns that into a restart the operator can see.
 */
export const LONG_RUNNING_SERVICES: ReadonlySet<string> = new Set(['memphis.service']);

/**
 * The units whose supervision policy is the LOCAL runtime's policy.
 *
 * `scripts/systemd/memphis.service` is the local user unit, and the unit
 * `memphis service install` writes must match it exactly.
 *
 * `ops/memphis.service` is deliberately NOT in this list: it is the
 * system-wide unit for small machines (`User=memphis`, `/opt/memphis`,
 * `multi-user.target`), and its `MemoryMax=1G` is a deployment choice
 * documented in `ops/memphis.service.override.conf` — a 2 GB VM cannot
 * afford the local unit's 4 GB. The hard rules still apply to it; only
 * the policy PARITY does not.
 */
export const LOCAL_POLICY_UNIT_FILES: ReadonlySet<string> = new Set([
  'scripts/systemd/memphis.service',
]);

/** What the gate calls the unit the generator would write. */
export const GENERATED_UNIT_FILE = 'src/infra/runtime/user-service.ts (generated unit)';

/**
 * Split a unit file into its sections.
 *
 * The start-limit pair is only read by systemd v229+ from `[Unit]`. A
 * unit that carries `StartLimitBurst=5` inside `[Service]` carries the
 * directive and runs with the DEFAULT limit — the cap looks present and
 * is not.
 */
export function parseUnitSections(src: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '';
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === '') continue;
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    sections.get(current)!.push(line);
  }
  return sections;
}

/**
 * The value of a directive, wherever it sits in the unit.
 *
 * The last occurrence wins, which is how systemd reads a repeated
 * directive.
 */
export function readDirective(src: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    value = trimmed.slice(eq + 1).trim();
  }
  return value;
}

/**
 * Directives inside `[Service]`. A unit may declare ExecStart=,
 * ExecStartPre=, ExecStop= or ExecStopPost= — systemd accepts any of
 * them as proof that the unit has something to run. The stub had none.
 */
export function hasRunnableDirective(src: string): boolean {
  return /^\s*Exec(Start|Stop)\w*\s*=/m.test(src);
}

function onFailureTargets(src: string): string[] {
  const targets: string[] = [];
  for (const match of src.matchAll(/^\s*OnFailure\s*=\s*(\S+)/gm)) {
    targets.push(match[1]);
  }
  return targets;
}

/** What the rules need to know about one unit. */
export interface UnitRuleInput {
  /** The unit's repo-relative path, or the generator's marker. */
  file: string;
  /** The unit's file name, e.g. `memphis.service`. */
  name: string;
  /** The unit's text. */
  src: string;
  /** The names of every unit this runtime ships. */
  knownUnitNames: readonly string[];
  /** The text of every unit this runtime ships, by name. */
  knownUnitSources?: ReadonlyMap<string, string>;
}

/**
 * The rules, applied to one unit.
 *
 * Returns an empty array when the unit satisfies every rule. The order
 * of the findings is the order of the rules, so a corpus can name them.
 */
export function findUnitFindings(input: UnitRuleInput): UnitRuleFinding[] {
  const findings: UnitRuleFinding[] = [];
  const { file, name, src } = input;

  if (!name.endsWith('.service')) return findings;

  if (!hasRunnableDirective(src)) {
    findings.push({
      rule: 'no-runnable-directive',
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

    if (!input.knownUnitNames.includes(target)) {
      findings.push({
        rule: 'dangling-onfailure',
        file,
        problem: `OnFailure= points at ${target}, which is not one of the shipped units`,
      });
      continue;
    }

    const targetSrc = input.knownUnitSources?.get(target);
    if (targetSrc !== undefined && !hasRunnableDirective(targetSrc)) {
      findings.push({
        rule: 'stub-onfailure-target',
        file,
        problem: `OnFailure= points at ${target}, which has no ExecStart= — the failure would be reported into the void`,
      });
    }
  }

  if (!LONG_RUNNING_SERVICES.has(name)) return findings;

  // A long-running service with no memory ceiling lets the kernel OOM
  // killer act instead of the supervisor. The operator then sees the
  // runtime die with no visible cause.
  if (!/^\s*MemoryMax\s*=\s*\S/m.test(src)) {
    findings.push({
      rule: 'no-memory-max',
      file,
      problem:
        'no MemoryMax= — a memory leak is stopped by the kernel OOM killer ' +
        'instead of by the supervisor, and the failure has no visible cause',
    });
  }

  // A long-running service that is only restarted ON FAILURE comes back
  // from a crash and stays down from a CLEAN exit — and the runtime's
  // clean exit is its ordinary way of stopping: it drains and exits 0.
  //
  // MEASURED 2026-11-25 on the operator's host, with a scratch unit: an
  // unsolicited SIGTERM that exits 0 left the unit `inactive` with pid 0
  // and nothing in the log saying why, while `Restart=always` brought it
  // back and still honoured `systemctl stop` (systemd does not restart a
  // unit the operator stopped).
  if (!/^\s*Restart\s*=\s*always\s*$/m.test(src)) {
    findings.push({
      rule: 'not-restart-always',
      file,
      problem:
        "Restart= is not `always` — a clean exit (the runtime's ordinary " +
        'drain exits 0) leaves the unit DOWN with nothing in the log saying ' +
        'why. `RestartPreventExitStatus` still stops the 101/102/103 codes.',
    });
  }

  // The start limit is the hard cap that ends a boot loop. It is read
  // from `[Unit]` by systemd v229+, and it is IGNORED in `[Service]` —
  // a unit that carries it in the wrong section runs with the default
  // limit (5 restarts in 10 seconds), which is a cap that does not cap.
  const sections = parseUnitSections(src);
  const unitSection = sections.get('Unit') ?? [];
  const serviceSection = sections.get('Service') ?? [];
  const hasStartLimitBurst = unitSection.some((line) => /^StartLimitBurst\s*=/.test(line));
  const hasStartLimitInterval = unitSection.some((line) => /^StartLimitIntervalSec\s*=/.test(line));
  if (!hasStartLimitBurst || !hasStartLimitInterval) {
    findings.push({
      rule: 'no-start-limit',
      file,
      problem:
        'no StartLimitBurst=/StartLimitIntervalSec= in [Unit] — a boot loop ' +
        'is capped by the systemd DEFAULT (5 restarts in 10 s), not by the ' +
        'cap this unit is supposed to carry',
    });
  }
  if (serviceSection.some((line) => /^StartLimit(Burst|IntervalSec)\s*=/.test(line))) {
    findings.push({
      rule: 'start-limit-in-service-section',
      file,
      problem:
        'StartLimit* is in [Service] — systemd v229+ reads it from [Unit], ' +
        'so the directive looks present and does nothing',
    });
  }

  // The mirror image of the rule above: a [Service] directive in [Unit].
  // systemd ignores it and logs "Unknown key name '…' in section 'Unit',
  // ignoring." — a unit that warns about its own policy is a unit nobody
  // reads carefully, and a policy that is written twice is a policy with
  // two owners.
  //
  // MEASURED 2026-11-25 on this host, in the GENERATOR: the first version
  // of the policy renderer put every directive into both sections, and
  // the parity rule did not see it — it read the last occurrence, which
  // was the right one. The warning was the only witness.
  const misplaced = unitSection
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((directive) => SERVICE_POLICY_SERVICE_DIRECTIVES.has(directive));
  if (misplaced.length > 0) {
    findings.push({
      rule: 'policy-directive-in-unit-section',
      file,
      problem:
        `${misplaced.join(', ')} in [Unit] — these are [Service] directives; ` +
        'systemd ignores them there and warns about them, and a policy ' +
        'written twice is a policy with two owners',
    });
  }

  // The local unit family has ONE policy, and the unit the generator
  // writes must carry it: the generator is what `memphis service install`
  // deploys, and a generator with its own idea of the policy will
  // overwrite a measured fix with a stale one.
  if (LOCAL_POLICY_UNIT_FILES.has(file) || file === GENERATED_UNIT_FILE) {
    const mismatches: string[] = [];
    for (const [directive, expected] of SERVICE_UNIT_POLICY_DIRECTIVES) {
      const actual = readDirective(src, directive);
      if (actual !== expected) {
        mismatches.push(`${directive}: expected ${expected}, found ${actual ?? '(absent)'}`);
      }
    }
    if (mismatches.length > 0) {
      findings.push({
        rule: 'policy-mismatch',
        file,
        problem:
          'the supervision policy differs from the one owner ' +
          '(src/infra/runtime/service-unit-policy.ts) — ' +
          mismatches.join('; '),
      });
    }
  }

  return findings;
}
