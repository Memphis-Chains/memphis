import type { SloReport, SloStatus } from './slo-evaluator.js';

/** These are the four measurements emitted by evaluateSlos. Missing evidence
 * is not a pass, including when a producer returns an empty report. */
export const REQUIRED_SLOS = [
  'p99_turn_latency_ms', 'confabulation_rate', 'provider_error_rate', 'tool_error_rate',
] as const;

export function assessSloReport(report: SloReport): {
  status: SloStatus; failingSlos: string[]; unavailableSlos: string[];
} {
  const failingSlos = report.slos.filter((slo) => slo.status === 'fail').map((slo) => slo.name);
  const unavailableSlos = report.slos.filter((slo) => slo.status !== 'pass' && slo.status !== 'fail').map((slo) => slo.name);
  for (const name of REQUIRED_SLOS) {
    if (report.slos.filter((slo) => slo.name === name).length !== 1 && !unavailableSlos.includes(name)) unavailableSlos.push(name);
  }
  return { status: failingSlos.length ? 'fail' : unavailableSlos.length ? 'unavailable' : 'pass',
    failingSlos, unavailableSlos };
}
