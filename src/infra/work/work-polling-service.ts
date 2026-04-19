import { CapacityWake } from './capacity-wake.js';
import { SessionTokenService } from './session-token-service.js';
import { AppError } from '../../core/errors.js';
import {
  SqliteWorkItemRepository,
  type WorkItemRecord,
  type WorkItemStatus,
} from '../storage/sqlite/repositories/work-item-repository.js';
import {
  SqliteWorkerSessionRepository,
  type WorkerSessionRecord,
} from '../storage/sqlite/repositories/worker-session-repository.js';

type CompletionStatus = Extract<WorkItemStatus, 'completed' | 'failed' | 'canceled'>;

export type WorkerAuthContext = {
  session: WorkerSessionRecord;
  capabilityScope: string[];
  token: string;
};

export type WorkPollingSnapshot = {
  tokenReady: boolean;
  sessionTtlMs: number;
  leaseTtlMs: number;
  sessions: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
  };
  work: {
    total: number;
    pending: number;
    leased: number;
    completed: number;
    failed: number;
    canceled: number;
    overdueLeases: number;
  };
};

export class WorkPollingService {
  private readonly sessionTtlMs: number;
  private readonly leaseTtlMs: number;

  constructor(
    private readonly workerSessionRepository: SqliteWorkerSessionRepository,
    private readonly workItemRepository: SqliteWorkItemRepository,
    private readonly tokenService: SessionTokenService,
    private readonly wake: CapacityWake,
    options?: {
      sessionTtlMs?: number;
      leaseTtlMs?: number;
    },
  ) {
    this.sessionTtlMs = options?.sessionTtlMs ?? 60 * 60 * 1000;
    this.leaseTtlMs = options?.leaseTtlMs ?? 30_000;
  }

  public registerWorker(input: { workerId: string; capabilityScope: string[] }): {
    session: WorkerSessionRecord;
    token: string;
    expiresAtMs: number;
  } {
    if (!this.tokenService.isReady()) {
      throw new AppError('TRANSIENT_ERROR', 'worker session token secret is not configured', 503);
    }

    const expiresAtMs = Date.now() + this.sessionTtlMs;
    const session = this.workerSessionRepository.create({
      workerId: input.workerId,
      capabilityScope: input.capabilityScope,
      expiresAtMs,
    });
    const token = this.tokenService.issue({
      sessionId: session.sessionId,
      workerId: session.workerId,
      capabilityScope: session.capabilityScope,
      expiresAtMs,
      epoch: session.tokenEpoch,
    });
    return { session, token, expiresAtMs };
  }

  public authenticateToken(token: string): WorkerAuthContext {
    const claims = this.tokenService.verify(token);
    const session = this.workerSessionRepository.get(claims.sid);
    if (!session) {
      throw new AppError('PERMISSION_DENIED', 'worker session not found', 401);
    }
    if (session.revokedAt) {
      throw new AppError('PERMISSION_DENIED', 'worker session revoked', 401);
    }
    if (session.tokenEpoch !== claims.epoch) {
      throw new AppError('PERMISSION_DENIED', 'worker session token is stale', 401);
    }
    if (session.expiresAtMs < Date.now()) {
      throw new AppError('PERMISSION_DENIED', 'worker session expired', 401);
    }
    const refreshedExpiry = Date.now() + this.sessionTtlMs;
    const refreshed = this.workerSessionRepository.touch(session.sessionId, refreshedExpiry);
    return {
      session: refreshed ?? session,
      capabilityScope: claims.scope,
      token,
    };
  }

  public refreshSession(auth: WorkerAuthContext): {
    session: WorkerSessionRecord;
    token: string;
    expiresAtMs: number;
  } {
    const expiresAtMs = Date.now() + this.sessionTtlMs;
    const session = this.workerSessionRepository.touch(auth.session.sessionId, expiresAtMs);
    if (!session) {
      throw new AppError('PERMISSION_DENIED', 'worker session not found', 401);
    }
    const token = this.tokenService.issue({
      sessionId: session.sessionId,
      workerId: session.workerId,
      capabilityScope: session.capabilityScope,
      expiresAtMs,
      epoch: session.tokenEpoch,
    });
    return { session, token, expiresAtMs };
  }

  public revokeSession(sessionId: string): WorkerSessionRecord {
    const session = this.workerSessionRepository.revoke(sessionId);
    if (!session) {
      throw new AppError('VALIDATION_ERROR', 'worker session not found', 404);
    }
    return session;
  }

  public getWorkItem(workId: string): WorkItemRecord | null {
    return this.workItemRepository.getById(workId);
  }

  public enqueueWork(input: {
    type: string;
    actorId?: string;
    conversationId?: string;
    capabilityScope?: string[];
    payload?: Record<string, unknown>;
  }): WorkItemRecord {
    const record = this.workItemRepository.enqueue(input);
    this.wake.notify();
    return record;
  }

  public async poll(
    auth: WorkerAuthContext,
    options?: { waitMs?: number },
  ): Promise<WorkItemRecord | null> {
    const work = this.tryLeaseNext(auth);
    if (work) return work;

    const waitMs = Math.max(0, Math.min(options?.waitMs ?? 15_000, 30_000));
    await this.wake.wait(waitMs);
    return this.tryLeaseNext(auth);
  }

  public acknowledgeWork(auth: WorkerAuthContext, workId: string): WorkItemRecord {
    const record = this.workItemRepository.acknowledgeLease(
      workId,
      auth.session.sessionId,
      Date.now() + this.leaseTtlMs,
    );
    if (!record) {
      throw new AppError('VALIDATION_ERROR', 'leased work item not found', 404);
    }
    return record;
  }

  public heartbeat(auth: WorkerAuthContext, workId: string): WorkItemRecord {
    const record = this.workItemRepository.heartbeat(
      workId,
      auth.session.sessionId,
      Date.now() + this.leaseTtlMs,
    );
    if (!record) {
      throw new AppError('VALIDATION_ERROR', 'leased work item not found', 404);
    }
    return record;
  }

  public completeWork(
    auth: WorkerAuthContext,
    input: {
      workId: string;
      status: CompletionStatus;
      result?: Record<string, unknown>;
    },
  ): WorkItemRecord {
    const record = this.workItemRepository.complete({
      workId: input.workId,
      workerSessionId: auth.session.sessionId,
      status: input.status,
      result: input.result,
    });
    if (!record) {
      throw new AppError('VALIDATION_ERROR', 'leased work item not found', 404);
    }
    return record;
  }

  public snapshot(): WorkPollingSnapshot {
    return {
      tokenReady: this.tokenService.isReady(),
      sessionTtlMs: this.sessionTtlMs,
      leaseTtlMs: this.leaseTtlMs,
      sessions: this.workerSessionRepository.snapshot(),
      work: this.workItemRepository.snapshot(),
    };
  }

  private tryLeaseNext(auth: WorkerAuthContext): WorkItemRecord | null {
    return this.workItemRepository.leaseNext({
      workerSessionId: auth.session.sessionId,
      capabilityScope: auth.capabilityScope,
      leaseExpiresAtMs: Date.now() + this.leaseTtlMs,
    });
  }
}
