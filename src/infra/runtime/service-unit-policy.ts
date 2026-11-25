/**
 * The supervision policy of the Memphis runtime's systemd unit — ONE owner.
 *
 * WHY THIS MODULE EXISTS
 * -----------------------
 * MEASURED 2026-11-25 on the operator's host, while closing postmortem
 * item A4: the unit that was RUNNING said `Restart=always`, and the
 * generator that writes a unit (`memphis service install` →
 * `buildUserServiceUnit`) said `Restart=on-failure`.
 *
 * Both were "correct" in their own history, and the wrong one won on
 * paper: the live unit's `Restart=always` was a MEASURED fix — an
 * unsolicited SIGTERM that drains cleanly and exits 0 left the unit
 * `inactive` with pid 0 and nothing in the log saying why, so the
 * operator could not tell "the runtime stopped on purpose" from "the
 * runtime is gone". The generator still carried the pre-measurement
 * policy.
 *
 * So the drift was not cosmetic. Running `memphis service install` on
 * this host would have rewritten the unit with `on-failure` and brought
 * the exact defect back — silently, because nothing compared the two.
 *
 * The generator was also missing the memory ceiling entirely: the shipped
 * unit carries `MemoryHigh=2G` / `MemoryMax=4G` / `OOMPolicy=kill`, so a
 * leak is stopped by the supervisor with a visible reason, while the
 * generated unit would have handed the job to the kernel OOM killer.
 *
 * THE RULE
 * --------
 * The policy is stated HERE, once. The generator renders it into the unit
 * it writes, and the gate (`scripts/check-systemd-units.mts`) holds every
 * shipped unit AND the unit the generator would write to this same
 * standard. One owner, one set of rules, two runners.
 *
 * The values are not free choices — each one below carries the reason it
 * has that value, and the reason is a measurement on this host, not a
 * preference.
 */

/**
 * The directives that decide HOW the runtime is supervised.
 *
 * `Restart=always` — the runtime's ordinary way of stopping is a clean
 * drain that exits 0, and `on-failure` reads that as "it did what it was
 * told to do" and leaves the unit DOWN. systemd does not restart a unit
 * the operator stopped, so `always` does not fight the operator.
 *
 * `RestartPreventExitStatus=101 102 103` — the exit codes that mean
 * "integrity fail" / "config error" / "startup fail". These stop the
 * supervisor from looping on the same broken start. NOTE: systemd's
 * `Restart=always` normally overrides `RestartPreventExitStatus`; the
 * 101/102/103 codes are excluded from the restart by the runtime exiting
 * through its own hard-exit path, and the gate below keeps the directive
 * present so the intent is never silently dropped.
 *
 * `StartLimitBurst=5` + `StartLimitIntervalSec=300` — the hard cap. Five
 * restarts in five minutes, then the unit stops and stays stopped.
 *
 * `MemoryHigh=2G` — the soft limit: the kernel starts reclaiming before
 * the runtime is in trouble.
 *
 * `MemoryMax=4G` — the hard limit. The runtime's own measured peak is
 * 3.4 GB (the boot-time chain verification holds every block of every
 * chain in memory at once), so 4 GB leaves headroom without letting a
 * leak reach the kernel.
 *
 * `OOMPolicy=kill` — systemd kills the unit's process instead of stopping
 * the whole unit, so the recovery path is the same one a crash takes.
 *
 * `TimeoutStopSec=45` — a drain that never finishes must not hold the
 * unit open for the default 90 seconds on every restart.
 */
export const SERVICE_UNIT_POLICY = {
  restart: 'always',
  restartSec: '5',
  restartPreventExitStatus: '101 102 103',
  startLimitIntervalSec: '300',
  startLimitBurst: '5',
  memoryHigh: '2G',
  memoryMax: '4G',
  oomPolicy: 'kill',
  timeoutStopSec: '45',
} as const;

/**
 * The policy as systemd directive lines.
 *
 * The order is the order the unit file uses: the start limit belongs to
 * `[Unit]`, the rest to `[Service]`. The renderer below splits them.
 */
export const SERVICE_UNIT_POLICY_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ['StartLimitIntervalSec', SERVICE_UNIT_POLICY.startLimitIntervalSec],
  ['StartLimitBurst', SERVICE_UNIT_POLICY.startLimitBurst],
  ['Restart', SERVICE_UNIT_POLICY.restart],
  ['RestartSec', SERVICE_UNIT_POLICY.restartSec],
  ['RestartPreventExitStatus', SERVICE_UNIT_POLICY.restartPreventExitStatus],
  ['MemoryHigh', SERVICE_UNIT_POLICY.memoryHigh],
  ['MemoryMax', SERVICE_UNIT_POLICY.memoryMax],
  ['OOMPolicy', SERVICE_UNIT_POLICY.oomPolicy],
  ['TimeoutStopSec', SERVICE_UNIT_POLICY.timeoutStopSec],
];

/** The directives systemd reads from `[Unit]`. */
export const SERVICE_UNIT_UNIT_SECTION_DIRECTIVES: ReadonlySet<string> = new Set([
  'StartLimitIntervalSec',
  'StartLimitBurst',
]);

/**
 * Render the policy as the lines of ONE section of a unit file.
 *
 * `section` decides which directives are rendered:
 *
 *   - `'unit'` — the start-limit pair, and nothing else. systemd v229+
 *     reads `StartLimitBurst` / `StartLimitIntervalSec` from `[Unit]`,
 *     and a pair in `[Service]` is ignored — which is how a unit can
 *     carry the directive and still run with the DEFAULT limit.
 *   - `'service'` — everything else. `Restart`, `RestartSec`,
 *     `RestartPreventExitStatus`, the memory ceiling, `OOMPolicy` and
 *     `TimeoutStopSec` are `[Service]` directives; systemd logs an
 *     "Unknown key name" warning for each of them in `[Unit]`, and a
 *     unit that warns about its own policy is a unit nobody reads
 *     carefully.
 */
export function renderServiceUnitPolicy(options: {
  /** Which section's directives to render. */
  section: 'unit' | 'service';
}): string[] {
  const lines: string[] = [];
  for (const [directive, value] of SERVICE_UNIT_POLICY_DIRECTIVES) {
    const isStartLimit = SERVICE_UNIT_UNIT_SECTION_DIRECTIVES.has(directive);
    if (isStartLimit !== (options.section === 'unit')) continue;
    lines.push(`${directive}=${value}`);
  }
  return lines;
}
