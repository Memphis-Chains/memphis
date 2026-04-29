import { evaluateSlos, type SloReport } from '../../observability/slo-evaluator.js';

export interface MemphisSloStatusInput {
  windowDays?: number;
}

export type MemphisSloStatusOutput = SloReport & {
  ok: boolean;
  failingSlos: string[];
};

export function runMemphisSloStatus(
  input: MemphisSloStatusInput = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisSloStatusOutput {
  const report = evaluateSlos({
    windowDays: input.windowDays,
    rawEnv,
  });
  const failingSlos = report.slos.filter((s) => s.status === 'fail').map((s) => s.name);
  return {
    ...report,
    ok: failingSlos.length === 0,
    failingSlos,
  };
}
