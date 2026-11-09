import { assessSloReport } from '../../observability/slo-assessment.js';
import { evaluateSlos, type SloReport } from '../../observability/slo-evaluator.js';

export interface MemphisSloStatusInput {
  windowDays?: number;
  /**
   * A window shorter than a day, for "how is it going right now" as opposed
   * to the weekly trend. The runtime watch needs the short one to decide
   * whether to alert; the report keeps the long one.
   */
  windowHours?: number;
}

export type MemphisSloStatusOutput = SloReport & {
  ok: boolean;
  allSlosPassing: boolean;
  failingSlos: string[];
  unavailableSlos: string[];
  status: 'pass' | 'fail' | 'unavailable';
};

export function runMemphisSloStatus(
  input: MemphisSloStatusInput = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSloStatusOutput {
  const report = evaluateSlos({
    windowDays: input.windowDays,
    windowHours: input.windowHours,
    rawEnv,
  });
  const assessment = assessSloReport(report);
  return {
    ...report,
    ok: true,
    allSlosPassing: assessment.status === 'pass',
    ...assessment,
  };
}
