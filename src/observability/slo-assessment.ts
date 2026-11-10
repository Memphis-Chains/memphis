import type { SloReport, SloStatus } from './slo-evaluator.js';

/** These are the four measurements emitted by evaluateSlos. Missing evidence
 * is not a pass, including when a producer returns an empty report. */
export const REQUIRED_SLOS = [
  'p99_turn_latency_ms',
  'confabulation_rate',
  'provider_error_rate',
  'tool_error_rate',
] as const;

/**
 * Metrics the report carries but the autonomy gate does NOT weigh.
 *
 * `p99_turn_duration_ms` is the p99 of a whole agent turn — every tool
 * call the operator asked for, included. A ninety-minute working
 * session is not a runtime fault, so a threshold over it says nothing
 * about the health of the system. The metric is still measured and
 * still reported (it is a hang detector: its threshold sits above the
 * longest turn ever recorded), but its verdict must not close the gate
 * that lets the runtime modify itself.
 *
 * Measured 2026-11-10: `assessSloReport` collected EVERY `fail` from
 * the report, not only the four gated ones. Adding a fifth metric would
 * have made the gate read a metric nobody intended it to weigh — and
 * the SLO report says in its own documentation that this one is
 * "reported, not gated". A metric that is described as reported but
 * blocks the gate is a metric that lies.
 */
export const REPORTED_ONLY_SLOS = ['p99_turn_duration_ms'] as const;

/**
 * What the report SAYS about every metric it carries.
 *
 * This is the reporting view: it names every metric that failed and
 * every metric with no evidence, including the reported-only ones. A
 * tool that hid them would be hiding the state of the system.
 */
export function assessSloReport(report: SloReport): {
  status: SloStatus;
  failingSlos: string[];
  unavailableSlos: string[];
} {
  const failingSlos = report.slos.filter((slo) => slo.status === 'fail').map((slo) => slo.name);
  const unavailableSlos = report.slos
    .filter((slo) => slo.status !== 'pass' && slo.status !== 'fail')
    .map((slo) => slo.name);
  for (const name of REQUIRED_SLOS) {
    if (
      report.slos.filter((slo) => slo.name === name).length !== 1 &&
      !unavailableSlos.includes(name)
    )
      unavailableSlos.push(name);
  }
  return {
    status: failingSlos.length ? 'fail' : unavailableSlos.length ? 'unavailable' : 'pass',
    failingSlos,
    unavailableSlos,
  };
}

/**
 * What the AUTONOMY GATE weighs.
 *
 * Same arithmetic, minus the metrics the operator marked as
 * reported-only. The gate closes on a failing or unmeasured metric,
 * because a runtime that cannot see its own health must not rewrite
 * itself. It must NOT close on a metric that is only there to be
 * reported: `p99_turn_duration_ms` is the p99 of a whole agent turn,
 * and a ninety-minute working session is not a runtime fault.
 *
 * Measured 2026-11-10: `assessSloReport` was used for both jobs, so
 * adding that metric would have made the gate read a metric nobody
 * intended it to weigh — while the SLO documentation says in plain
 * words that this one is "reported, not gated". A metric described as
 * reported but that blocks the gate is a metric that lies.
 *
 * The opt-out is an explicit list, not a default: a metric that is
 * neither listed here nor in `REPORTED_ONLY_SLOS` still closes the
 * gate. The fail-closed default is the safe one for a system that
 * rewrites itself.
 */
export function assessGatedSlos(report: SloReport): {
  status: SloStatus;
  failingSlos: string[];
  unavailableSlos: string[];
} {
  const reportedOnly = new Set<string>(REPORTED_ONLY_SLOS);
  const gated = report.slos.filter((slo) => !reportedOnly.has(slo.name));
  const failingSlos = gated.filter((slo) => slo.status === 'fail').map((slo) => slo.name);
  const unavailableSlos = gated
    .filter((slo) => slo.status !== 'pass' && slo.status !== 'fail')
    .map((slo) => slo.name);
  for (const name of REQUIRED_SLOS) {
    if (
      report.slos.filter((slo) => slo.name === name).length !== 1 &&
      !unavailableSlos.includes(name)
    )
      unavailableSlos.push(name);
  }
  return {
    status: failingSlos.length ? 'fail' : unavailableSlos.length ? 'unavailable' : 'pass',
    failingSlos,
    unavailableSlos,
  };
}
