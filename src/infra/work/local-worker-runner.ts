import {
  executeChatGeneratePayload,
  finalizeCompletedChatGenerateWork,
  parseChatDispatchWorkPayload,
  type HttpChatRuntimeDeps,
} from './chat-work.js';
import {
  executeScheduledTaskWorkPayload,
  finalizeCompletedScheduledTaskWork,
  parseScheduledTaskWorkPayload,
} from './scheduler-work.js';
import { DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE } from './work-capabilities.js';
import type { WorkerAuthContext, WorkPollingService } from './work-polling-service.js';
import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../core/contracts/repository.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import {
  getLocalWorkerRuntimeStatus,
  patchLocalWorkerRuntimeStatus,
  setLocalWorkerRuntimeStatus,
} from '../runtime/local-worker-state.js';
import type { SqliteOperatorChatSessionRepository } from '../storage/sqlite/repositories/operator-chat-session-repository.js';
import type { WorkItemRecord } from '../storage/sqlite/repositories/work-item-repository.js';

type LocalWorkerRunnerDeps = {
  workPollingService: WorkPollingService;
  orchestration: OrchestrationService;
  runtime?: HttpChatRuntimeDeps;
  sessionRepository?: SessionRepository;
  generationEventRepository?: GenerationEventRepository;
  operatorChatSessionRepository?: SqliteOperatorChatSessionRepository;
};

type LocalWorkerRunnerOptions = {
  workerId?: string;
  capabilityScope?: string[];
  waitMs?: number;
  refreshSkewMs?: number;
  source?: 'bootstrap' | 'cli';
};

export type LocalWorkerRunOutcome =
  | { worked: false }
  | { worked: true; workId: string; status: 'completed' | 'failed' };

export class LocalWorkerRunner {
  private readonly workerId: string;
  private readonly capabilityScope: string[];
  private readonly waitMs: number;
  private readonly refreshSkewMs: number;
  private readonly leaseTtlMs: number;
  private readonly source: 'bootstrap' | 'cli';
  private token: string | null = null;
  private expiresAtMs = 0;
  private running = false;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private readonly counters = {
    leased: 0,
    completed: 0,
    failed: 0,
    emptyPolls: 0,
  };

  constructor(
    private readonly deps: LocalWorkerRunnerDeps,
    options: LocalWorkerRunnerOptions = {},
  ) {
    this.workerId = options.workerId?.trim() || `local-worker:${process.pid}`;
    this.capabilityScope = options.capabilityScope?.length
      ? [...new Set(options.capabilityScope)]
      : [...DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE];
    this.waitMs = Math.max(0, Math.min(options.waitMs ?? 5_000, 30_000));
    this.refreshSkewMs = Math.max(1_000, options.refreshSkewMs ?? 15_000);
    this.leaseTtlMs = deps.workPollingService.snapshot().leaseTtlMs;
    this.source = options.source ?? 'cli';
  }

  public start(): void {
    if (this.running || this.stopped) {
      return;
    }
    this.initializeRuntimeStatus('starting');
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
    patchLocalWorkerRuntimeStatus({
      state: 'stopped',
      currentWorkId: undefined,
      stoppedAt: new Date().toISOString(),
      processed: { ...this.counters },
    });
  }

  public async runOnce(waitMs = 0): Promise<LocalWorkerRunOutcome> {
    this.initializeRuntimeStatus('idle');
    const auth = await this.ensureAuth();
    patchLocalWorkerRuntimeStatus({
      state: 'idle',
      lastPollAt: new Date().toISOString(),
      tokenReady: true,
    });
    const work = await this.deps.workPollingService.poll(auth, { waitMs });
    if (!work) {
      this.counters.emptyPolls += 1;
      patchLocalWorkerRuntimeStatus({
        state: 'idle',
        processed: { ...this.counters },
      });
      return { worked: false };
    }

    this.counters.leased += 1;
    patchLocalWorkerRuntimeStatus({
      state: 'busy',
      currentWorkId: work.workId,
      lastWorkId: work.workId,
      processed: { ...this.counters },
    });
    const ackAuth = await this.ensureAuth();
    this.deps.workPollingService.acknowledgeWork(ackAuth, work.workId);
    const heartbeat = this.startHeartbeat(work.workId);

    try {
      const outcome = await this.executeWorkItem(work);
      if (outcome.status === 'completed') {
        this.counters.completed += 1;
      } else {
        this.counters.failed += 1;
      }
      patchLocalWorkerRuntimeStatus({
        state: 'idle',
        currentWorkId: undefined,
        lastWorkId: work.workId,
        lastOutcome: outcome.status === 'completed' ? 'completed' : 'failed',
        lastError: outcome.error,
        processed: { ...this.counters },
      });
      return {
        worked: true,
        workId: work.workId,
        status: outcome.status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.completeFailure(work.workId, 'WORK_EXECUTION_FAILED', message);
      this.counters.failed += 1;
      patchLocalWorkerRuntimeStatus({
        state: 'idle',
        currentWorkId: undefined,
        lastWorkId: work.workId,
        lastOutcome: 'failed',
        lastError: message,
        processed: { ...this.counters },
      });
      return { worked: true, workId: work.workId, status: 'failed' };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce(this.waitMs);
      } catch (error) {
        patchLocalWorkerRuntimeStatus({
          state: 'error',
          currentWorkId: undefined,
          lastError: error instanceof Error ? error.message : String(error),
          processed: { ...this.counters },
        });
      }
    }
    this.running = false;
  }

  private initializeRuntimeStatus(state: 'starting' | 'idle'): void {
    const current = getLocalWorkerRuntimeStatus();
    if (current !== null) {
      patchLocalWorkerRuntimeStatus({
        enabled: true,
        source: this.source,
        state,
        workerId: this.workerId,
        capabilityScope: this.capabilityScope,
        tokenReady: this.deps.workPollingService.snapshot().tokenReady,
        startedAt: current.startedAt ?? new Date().toISOString(),
        lastOutcome: current.lastOutcome ?? 'none',
        processed: { ...this.counters },
      });
      return;
    }

    setLocalWorkerRuntimeStatus({
      enabled: true,
      source: this.source,
      state,
      workerId: this.workerId,
      capabilityScope: this.capabilityScope,
      tokenReady: this.deps.workPollingService.snapshot().tokenReady,
      startedAt: new Date().toISOString(),
      lastOutcome: 'none',
      processed: { ...this.counters },
    });
  }

  private async ensureAuth(): Promise<WorkerAuthContext> {
    if (!this.token) {
      const registered = this.deps.workPollingService.registerWorker({
        workerId: this.workerId,
        capabilityScope: this.capabilityScope,
      });
      this.token = registered.token;
      this.expiresAtMs = registered.expiresAtMs;
      patchLocalWorkerRuntimeStatus({
        tokenReady: true,
      });
    }

    let auth = this.deps.workPollingService.authenticateToken(this.token);
    if (Date.now() + this.refreshSkewMs >= this.expiresAtMs) {
      const refreshed = this.deps.workPollingService.refreshSession(auth);
      this.token = refreshed.token;
      this.expiresAtMs = refreshed.expiresAtMs;
      auth = this.deps.workPollingService.authenticateToken(refreshed.token);
      patchLocalWorkerRuntimeStatus({
        tokenReady: true,
      });
    }
    return auth;
  }

  private startHeartbeat(workId: string): ReturnType<typeof setInterval> {
    const intervalMs = Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
    return setInterval(() => {
      void this.sendHeartbeat(workId);
    }, intervalMs);
  }

  private async sendHeartbeat(workId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const auth = await this.ensureAuth();
      this.deps.workPollingService.heartbeat(auth, workId);
      patchLocalWorkerRuntimeStatus({
        lastHeartbeatAt: new Date().toISOString(),
      });
    } catch {
      // Heartbeat is best-effort. Completion path will still resolve lease state.
    }
  }

  private async completeFailure(workId: string, code: string, message: string): Promise<WorkItemRecord> {
    const auth = await this.ensureAuth();
    return this.deps.workPollingService.completeWork(auth, {
      workId,
      status: 'failed',
      result: { code, message },
    });
  }

  private async executeWorkItem(
    work: WorkItemRecord,
  ): Promise<{ status: 'completed' | 'failed'; error?: string }> {
    if (work.type === 'chat.generate') {
      return this.executeChatGenerateWork(work);
    }
    if (work.type === 'scheduler.execute') {
      return this.executeSchedulerWork(work);
    }

    await this.completeFailure(work.workId, 'INVALID_WORK_ITEM', 'unsupported or invalid work item');
    return {
      status: 'failed',
      error: 'unsupported or invalid work item',
    };
  }

  private async executeChatGenerateWork(
    work: WorkItemRecord,
  ): Promise<{ status: 'completed' | 'failed'; error?: string }> {
    const payload = parseChatDispatchWorkPayload(work.payload);
    if (!payload) {
      await this.completeFailure(work.workId, 'INVALID_WORK_ITEM', 'unsupported or invalid work item');
      return {
        status: 'failed',
        error: 'unsupported or invalid work item',
      };
    }

    const result = await executeChatGeneratePayload(
      this.deps.orchestration,
      this.deps.runtime,
      payload,
      {
        requestId: payload.requestId ?? work.workId,
        queueTaskId: work.workId,
        source: 'local-worker',
        persistSession: false,
      },
    );

    const completeAuth = await this.ensureAuth();
    const completed = this.deps.workPollingService.completeWork(completeAuth, {
      workId: work.workId,
      status: 'completed',
      result,
    });
    finalizeCompletedChatGenerateWork(completed, {
      sessionRepository: this.deps.sessionRepository,
      generationEventRepository: this.deps.generationEventRepository,
      operatorChatSessionRepository: this.deps.operatorChatSessionRepository,
    });
    return { status: 'completed' };
  }

  private async executeSchedulerWork(
    work: WorkItemRecord,
  ): Promise<{ status: 'completed' | 'failed'; error?: string }> {
    const payload = parseScheduledTaskWorkPayload(work.payload);
    if (!payload) {
      await this.completeFailure(work.workId, 'INVALID_WORK_ITEM', 'unsupported or invalid work item');
      return {
        status: 'failed',
        error: 'unsupported or invalid work item',
      };
    }

    const result = await executeScheduledTaskWorkPayload(payload);
    const status = result.success ? 'completed' : 'failed';
    const completeAuth = await this.ensureAuth();
    const completed = this.deps.workPollingService.completeWork(completeAuth, {
      workId: work.workId,
      status,
      result,
    });
    await finalizeCompletedScheduledTaskWork(completed);
    return {
      status,
      error: result.success ? undefined : result.error ?? result.output,
    };
  }
}
