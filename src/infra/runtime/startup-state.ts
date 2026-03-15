import type { RevocationCacheStartupStatus, TrustRootStartupStatus } from './startup-guards.js';
import type { TaskQueueResumePolicy } from '../storage/task-queue-service.js';

export interface StartupQueueResumeStatus {
  policy: TaskQueueResumePolicy;
  safeModeOverrideApplied: boolean;
  scanned: number;
  redispatched: number;
  failed: number;
  canceled: number;
  kept: number;
  errors: string[];
  completedAt: string;
}

export interface SafeModeNetworkStatus {
  enabled: boolean;
  attempted: boolean;
  enforced: boolean;
  backend: 'iptables' | 'none';
  mode: 'disabled' | 'enforced' | 'degraded';
  reason?: string;
  checkedAt: string;
}

let startupQueueResumeStatus: StartupQueueResumeStatus | null = null;
let startupSafeModeNetworkStatus: SafeModeNetworkStatus | null = null;
let startupTrustRootStatus: TrustRootStartupStatus | null = null;
let startupRevocationCacheStatus: RevocationCacheStartupStatus | null = null;

export function setStartupQueueResumeStatus(
  input: Omit<StartupQueueResumeStatus, 'completedAt'> & { completedAt?: string },
): StartupQueueResumeStatus {
  startupQueueResumeStatus = {
    ...input,
    errors: [...input.errors],
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
  return getStartupQueueResumeStatus() as StartupQueueResumeStatus;
}

export function getStartupQueueResumeStatus(): StartupQueueResumeStatus | null {
  if (!startupQueueResumeStatus) return null;
  return {
    ...startupQueueResumeStatus,
    errors: [...startupQueueResumeStatus.errors],
  };
}

export function setStartupSafeModeNetworkStatus(
  input: Omit<SafeModeNetworkStatus, 'checkedAt'> & { checkedAt?: string },
): SafeModeNetworkStatus {
  startupSafeModeNetworkStatus = {
    ...input,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
  return getStartupSafeModeNetworkStatus() as SafeModeNetworkStatus;
}

export function getStartupSafeModeNetworkStatus(): SafeModeNetworkStatus | null {
  if (!startupSafeModeNetworkStatus) return null;
  return { ...startupSafeModeNetworkStatus };
}

export function setStartupTrustRootStatus(
  input: Omit<TrustRootStartupStatus, 'checkedAt'> & { checkedAt?: string },
): TrustRootStartupStatus {
  startupTrustRootStatus = {
    ...input,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
  return getStartupTrustRootStatus() as TrustRootStartupStatus;
}

export function getStartupTrustRootStatus(): TrustRootStartupStatus | null {
  if (!startupTrustRootStatus) return null;
  return { ...startupTrustRootStatus };
}

export function setStartupRevocationCacheStatus(
  input: Omit<RevocationCacheStartupStatus, 'checkedAt'> & { checkedAt?: string },
): RevocationCacheStartupStatus {
  startupRevocationCacheStatus = {
    ...input,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
  return getStartupRevocationCacheStatus() as RevocationCacheStartupStatus;
}

export function getStartupRevocationCacheStatus(): RevocationCacheStartupStatus | null {
  if (!startupRevocationCacheStatus) return null;
  return { ...startupRevocationCacheStatus };
}

export function resetStartupRuntimeStateForTests(): void {
  startupQueueResumeStatus = null;
  startupSafeModeNetworkStatus = null;
  startupTrustRootStatus = null;
  startupRevocationCacheStatus = null;
}
