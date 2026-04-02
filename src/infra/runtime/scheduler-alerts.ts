import type { SchedulerRuntimeStatus } from './scheduler.js';
import { addBootstrapWarning } from './startup-state.js';
import { getRuntimeAlertEmitter } from '../logging/alert-runtime.js';

export async function reportSchedulerWorkerFallback(
  status: SchedulerRuntimeStatus,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (status.configuredTarget !== 'workers' || status.effectiveTarget === 'workers') {
    return false;
  }

  const reason =
    status.fallbackReason?.trim() || 'scheduler worker execution fell back to local execution';
  addBootstrapWarning({
    component: 'scheduler',
    message: 'Scheduler worker execution fell back to local execution',
    detail: reason,
  });

  const emitter = getRuntimeAlertEmitter(rawEnv);
  await emitter.emit({
    id: 'SchedulerWorkerFallback',
    severity: 'high',
    message: 'Scheduler worker execution fell back to local execution',
    details: {
      configuredTarget: status.configuredTarget,
      effectiveTarget: status.effectiveTarget,
      workerLaneReady: status.workerLaneReady,
      running: status.running,
      reason,
    },
  });

  return true;
}
