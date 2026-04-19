import {
  repairRuntimeState,
  type RuntimeRepairOptions,
} from '../../infra/runtime/runtime-repair.js';

export type MemphisRepairOutput = {
  ok: boolean;
  repairable: boolean;
  status: 'healthy' | 'degraded-repairable' | 'degraded-manual';
  recommendedAction: string;
  applied: string[];
  skipped: string[];
  warnings: string[];
};

function formatRepairResult(
  result: Awaited<ReturnType<typeof repairRuntimeState>>,
): MemphisRepairOutput {
  return {
    ok: result.ok,
    repairable: result.repairable,
    status: result.status,
    recommendedAction: result.recommendedAction,
    applied: result.applied,
    skipped: result.skipped,
    warnings: result.warnings,
  };
}

export async function runMemphisRepair(
  options: RuntimeRepairOptions = {},
): Promise<MemphisRepairOutput> {
  const result = await repairRuntimeState(options);
  return formatRepairResult(result);
}
