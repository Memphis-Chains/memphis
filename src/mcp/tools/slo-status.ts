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
  const failingSlos = report.slos.filter((s) => s.status === 'fail').map((s) => s.name);
  return {
    ...report,
    ok: true,
    allSlosPassing: failingSlos.length === 0,
    failingSlos,
  };
}
