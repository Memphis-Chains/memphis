export type LocalWorkerRuntimeState =
  | 'disabled'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'stopped'
  | 'error';

export type LocalWorkerRuntimeStatus = {
  enabled: boolean;
  source: 'bootstrap' | 'cli';
  state: LocalWorkerRuntimeState;
  workerId?: string;
  capabilityScope: string[];
  tokenReady?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  currentWorkId?: string;
  lastWorkId?: string;
  lastPollAt?: string;
  lastHeartbeatAt?: string;
  lastOutcome?: 'completed' | 'failed' | 'none';
  lastError?: string;
  processed: {
    leased: number;
    completed: number;
    failed: number;
    emptyPolls: number;
  };
  updatedAt: string;
};

let localWorkerRuntimeStatus: LocalWorkerRuntimeStatus | null = null;

function cloneStatus(status: LocalWorkerRuntimeStatus): LocalWorkerRuntimeStatus {
  return {
    ...status,
    capabilityScope: [...status.capabilityScope],
    processed: { ...status.processed },
  };
}

export function setLocalWorkerRuntimeStatus(
  input: Omit<LocalWorkerRuntimeStatus, 'updatedAt'> & { updatedAt?: string },
): LocalWorkerRuntimeStatus {
  localWorkerRuntimeStatus = {
    ...input,
    capabilityScope: [...input.capabilityScope],
    processed: { ...input.processed },
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  return cloneStatus(localWorkerRuntimeStatus);
}

export function getLocalWorkerRuntimeStatus(): LocalWorkerRuntimeStatus | null {
  return localWorkerRuntimeStatus ? cloneStatus(localWorkerRuntimeStatus) : null;
}

export function patchLocalWorkerRuntimeStatus(
  input: Partial<Omit<LocalWorkerRuntimeStatus, 'processed' | 'capabilityScope'>> & {
    capabilityScope?: string[];
    processed?: Partial<LocalWorkerRuntimeStatus['processed']>;
  },
): LocalWorkerRuntimeStatus | null {
  if (!localWorkerRuntimeStatus) {
    return null;
  }

  localWorkerRuntimeStatus = {
    ...localWorkerRuntimeStatus,
    ...input,
    capabilityScope: input.capabilityScope
      ? [...input.capabilityScope]
      : [...localWorkerRuntimeStatus.capabilityScope],
    processed: {
      ...localWorkerRuntimeStatus.processed,
      ...(input.processed ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };
  return cloneStatus(localWorkerRuntimeStatus);
}

export function resetLocalWorkerRuntimeStatusForTests(): void {
  localWorkerRuntimeStatus = null;
}
