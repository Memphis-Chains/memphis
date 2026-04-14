import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseBool } from '../../core/env.js';
import type { SchedulerRuntimeStatus } from '../runtime/scheduler.js';

export type ProviderMetric = {
  provider: string;
  success: number;
  failure: number;
  totalLatencyMs: number;
  calls: number;
};

type HttpMetric = {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  errors: number;
  durationCount: number;
  durationSumSeconds: number;
  durationBuckets: number[];
};

type SafeModeDenialMetric = {
  method: string;
  route: string;
  count: number;
};

type DualApprovalTransitionMetric = {
  action: string;
  toState: string;
  count: number;
};

type ModelDProposalMetric = {
  vote: string;
  count: number;
};

const HISTOGRAM_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Codex Round 5 P1 fix: end-to-end turn duration needs a wider tail
// because the SLO checks p99 ≤ 30s. The HTTP histogram caps at 10s
// (right for HTTP enqueue latency) — turns can legitimately run
// longer through Ollama / chained tool calls.
export const TURN_HISTOGRAM_BUCKETS_SECONDS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 8, 10, 15, 20, 30, 60, 120,
];

function labels(input: Record<string, string | number>): string {
  const parts: string[] = [];
  for (const key in input) {
    const raw = input[key];
    if (raw === undefined) continue;
    const value = String(raw).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    parts.push(`${key}="${value}"`);
  }
  return `{${parts.join(',')}}`;
}

function statusClass(code: number): string {
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  if (code >= 200) return '2xx';
  return '1xx';
}

function countBlocksInJson(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const obj = raw as { blocks?: unknown; chain?: unknown };
  if (Array.isArray(obj.blocks)) return obj.blocks.length;
  if (Array.isArray(obj.chain)) return obj.chain.length;
  return 0;
}

export class InMemoryMetrics {
  private providerStats = new Map<string, ProviderMetric>();
  private httpStats = new Map<string, HttpMetric>();
  private safeModeDenialStats = new Map<string, SafeModeDenialMetric>();
  private dualApprovalTransitionStats = new Map<string, DualApprovalTransitionMetric>();

  private askRequestsTotal = 0;
  private askRequestsByProvider = new Map<string, number>();
  private askLatencyByProvider = new Map<string, { count: number; sumSeconds: number }>();

  private embedQueriesTotal = 0;
  private embedHitsSumTotal = 0;
  private embedCacheHitsTotal = 0;
  private embedCacheMissesTotal = 0;

  private chainBlocksTotal = 0;
  private chainSizeBytes = 0;
  private queueOverloadTotal = 0;
  private safeModeDenialsTotal = 0;
  private dualApprovalTransitionsTotal = 0;

  private modelDProposalsTotal = 0;
  private modelDProposalsByVote = new Map<string, ModelDProposalMetric>();
  private modelDLatencyCount = 0;
  private modelDLatencySumSeconds = 0;

  private scheduleJobsCreated = 0;
  private scheduleJobsCompleted = 0;
  private scheduleJobsFailed = 0;
  private scheduleJobsCanceled = 0;
  private schedulerConfiguredTarget: 'local' | 'workers' = 'local';
  private schedulerEffectiveTarget: 'local' | 'workers' = 'local';
  private schedulerRunning = false;
  private schedulerWorkerLaneReady: boolean | null = null;
  private schedulerFallbackActive = false;
  private schedulerFallbacksTotal = 0;
  private schedulerTasksTotal = 0;
  private schedulerTasksEnabled = 0;
  private schedulerTasksOverdue = 0;

  // Codex Round 5 P1 fix: end-to-end turn duration histogram (separate
  // from the HTTP /v1/chat/dispatch latency, which only measures the
  // enqueue path). Used by the SLO probe.
  private turnDurationCount = 0;
  private turnDurationSumSeconds = 0;
  private turnDurationBuckets: number[] = TURN_HISTOGRAM_BUCKETS_SECONDS.map(() => 0);

  public metricsEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
    return parseBool(rawEnv.METRICS_ENABLED, true);
  }

  /**
   * Record an end-to-end turn duration. Called from runTurnRuntime
   * after the full turn has produced its final output (including all
   * cascade fallbacks, tool calls, and audit writes).
   */
  public recordTurnDuration(durationMs: number): void {
    const dSec = Math.max(0, durationMs / 1000);
    this.turnDurationCount += 1;
    this.turnDurationSumSeconds += dSec;
    for (let i = 0; i < TURN_HISTOGRAM_BUCKETS_SECONDS.length; i += 1) {
      if (dSec <= TURN_HISTOGRAM_BUCKETS_SECONDS[i]!) {
        this.turnDurationBuckets[i]! += 1;
      }
    }
  }

  public recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const cls = statusClass(statusCode);
    const key = `${method}:${route}:${cls}`;
    const prev = this.httpStats.get(key) ?? {
      method,
      route,
      statusClass: cls,
      count: 0,
      errors: 0,
      durationCount: 0,
      durationSumSeconds: 0,
      durationBuckets: HISTOGRAM_BUCKETS_SECONDS.map(() => 0),
    };

    prev.count += 1;
    if (statusCode >= 400) prev.errors += 1;

    const dSec = Math.max(0, durationMs / 1000);
    prev.durationCount += 1;
    prev.durationSumSeconds += dSec;
    for (let i = 0; i < HISTOGRAM_BUCKETS_SECONDS.length; i += 1) {
      if (dSec <= HISTOGRAM_BUCKETS_SECONDS[i]!) {
        prev.durationBuckets[i]! += 1;
      }
    }

    this.httpStats.set(key, prev);
  }

  public recordProviderCall(provider: string, ok: boolean, latencyMs: number): void {
    const prev = this.providerStats.get(provider) ?? {
      provider,
      success: 0,
      failure: 0,
      totalLatencyMs: 0,
      calls: 0,
    };

    prev.calls += 1;
    prev.totalLatencyMs += latencyMs;
    if (ok) prev.success += 1;
    else prev.failure += 1;

    this.providerStats.set(provider, prev);

    this.askRequestsTotal += 1;
    this.askRequestsByProvider.set(provider, (this.askRequestsByProvider.get(provider) ?? 0) + 1);

    const current = this.askLatencyByProvider.get(provider) ?? { count: 0, sumSeconds: 0 };
    current.count += 1;
    current.sumSeconds += Math.max(0, latencyMs / 1000);
    this.askLatencyByProvider.set(provider, current);
  }

  public recordQueueOverload(): void {
    this.queueOverloadTotal += 1;
  }

  public recordSafeModeDenial(method: string, route: string): void {
    this.safeModeDenialsTotal += 1;
    const key = `${method}:${route}`;
    const current = this.safeModeDenialStats.get(key) ?? { method, route, count: 0 };
    current.count += 1;
    this.safeModeDenialStats.set(key, current);
  }

  public recordDualApprovalTransition(action: string, toState: string): void {
    this.dualApprovalTransitionsTotal += 1;
    const key = `${action}:${toState}`;
    const current = this.dualApprovalTransitionStats.get(key) ?? {
      action,
      toState,
      count: 0,
    };
    current.count += 1;
    this.dualApprovalTransitionStats.set(key, current);
  }

  public recordModelDProposal(vote: string, latencyMs: number): void {
    this.modelDProposalsTotal += 1;
    const key = vote;
    const current = this.modelDProposalsByVote.get(key) ?? { vote, count: 0 };
    current.count += 1;
    this.modelDProposalsByVote.set(key, current);

    this.modelDLatencyCount += 1;
    this.modelDLatencySumSeconds += Math.max(0, latencyMs / 1000);
  }

  public recordEmbedQuery(hitCount: number): void {
    this.embedQueriesTotal += 1;
    this.embedHitsSumTotal += Math.max(0, hitCount);
  }

  public recordEmbedCacheHit(): void {
    this.embedCacheHitsTotal += 1;
  }

  public recordEmbedCacheMiss(): void {
    this.embedCacheMissesTotal += 1;
  }

  public recordScheduleJobCreated(): void {
    this.scheduleJobsCreated += 1;
  }

  public recordScheduleJobCompleted(): void {
    this.scheduleJobsCompleted += 1;
  }

  public recordScheduleJobFailed(): void {
    this.scheduleJobsFailed += 1;
  }

  public recordScheduleJobCanceled(): void {
    this.scheduleJobsCanceled += 1;
  }

  public observeSchedulerRuntime(status: SchedulerRuntimeStatus): void {
    const fallbackActive =
      status.configuredTarget === 'workers' && status.effectiveTarget !== 'workers';
    if (fallbackActive && !this.schedulerFallbackActive) {
      this.schedulerFallbacksTotal += 1;
    }

    this.schedulerConfiguredTarget = status.configuredTarget;
    this.schedulerEffectiveTarget = status.effectiveTarget;
    this.schedulerRunning = status.running;
    this.schedulerWorkerLaneReady = status.workerLaneReady ?? null;
    this.schedulerFallbackActive = fallbackActive;
    this.schedulerTasksTotal = Math.max(0, Math.floor(status.tasks.total));
    this.schedulerTasksEnabled = Math.max(0, Math.floor(status.tasks.enabled));
    this.schedulerTasksOverdue = Math.max(0, Math.floor(status.tasks.overdue));
  }

  public setChainSnapshot(blocksTotal: number, sizeBytes: number): void {
    this.chainBlocksTotal = Math.max(0, Math.floor(blocksTotal));
    this.chainSizeBytes = Math.max(0, Math.floor(sizeBytes));
  }

  public collectChainSnapshot(rawEnv: NodeJS.ProcessEnv = process.env): void {
    const baseDir = resolve(rawEnv.METRICS_CHAIN_SCAN_DIR ?? './data');
    let blocks = 0;
    let bytes = 0;

    try {
      const files = readdirSync(baseDir);
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        const full = join(baseDir, name);
        const s = statSync(full);
        if (!s.isFile()) continue;
        bytes += s.size;
        try {
          const content = readFileSync(full, 'utf8');
          blocks += countBlocksInJson(JSON.parse(content));
        } catch {
          // ignore malformed files for metrics best-effort collection
        }
      }
    } catch {
      // ignore missing dir; keep zeros
    }

    this.setChainSnapshot(blocks, bytes);
  }

  public snapshot() {
    const providers = [...this.providerStats.values()].map((p) => ({
      ...p,
      avgLatencyMs: p.calls > 0 ? Math.round(p.totalLatencyMs / p.calls) : 0,
    }));

    return {
      ts: new Date().toISOString(),
      providers,
      ask: {
        requestsTotal: this.askRequestsTotal,
      },
      embed: {
        queriesTotal: this.embedQueriesTotal,
        hitsSumTotal: this.embedHitsSumTotal,
        cacheHitsTotal: this.embedCacheHitsTotal,
        cacheMissesTotal: this.embedCacheMissesTotal,
      },
      chain: {
        blocksTotal: this.chainBlocksTotal,
        sizeBytes: this.chainSizeBytes,
      },
      queue: {
        overloadTotal: this.queueOverloadTotal,
      },
      safeMode: {
        denialsTotal: this.safeModeDenialsTotal,
      },
      dualApproval: {
        transitionsTotal: this.dualApprovalTransitionsTotal,
      },
      modelD: {
        proposalsTotal: this.modelDProposalsTotal,
        byVote: Object.fromEntries(this.modelDProposalsByVote),
        latencyCount: this.modelDLatencyCount,
        latencySumSeconds: this.modelDLatencySumSeconds,
        avgLatencyMs:
          this.modelDLatencyCount > 0
            ? Math.round((this.modelDLatencySumSeconds / this.modelDLatencyCount) * 1000)
            : 0,
      },
      schedule: {
        created: this.scheduleJobsCreated,
        completed: this.scheduleJobsCompleted,
        failed: this.scheduleJobsFailed,
        canceled: this.scheduleJobsCanceled,
        runtime: {
          configuredTarget: this.schedulerConfiguredTarget,
          effectiveTarget: this.schedulerEffectiveTarget,
          running: this.schedulerRunning,
          workerLaneReady: this.schedulerWorkerLaneReady,
          fallbackActive: this.schedulerFallbackActive,
          fallbacksTotal: this.schedulerFallbacksTotal,
          tasks: {
            total: this.schedulerTasksTotal,
            enabled: this.schedulerTasksEnabled,
            overdue: this.schedulerTasksOverdue,
          },
        },
      },
    };
  }

  public toPrometheus(): string {
    const lines: string[] = [];

    lines.push('# HELP requests_total Total number of HTTP requests processed.');
    lines.push('# TYPE requests_total counter');
    for (const m of this.httpStats.values()) {
      lines.push(
        `requests_total${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.count}`,
      );
    }

    lines.push(
      '# HELP errors_total Total number of HTTP requests that resulted in error (status >= 400).',
    );
    lines.push('# TYPE errors_total counter');
    for (const m of this.httpStats.values()) {
      lines.push(
        `errors_total${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.errors}`,
      );
    }

    lines.push('# HELP request_duration_seconds HTTP request latency in seconds.');
    lines.push('# TYPE request_duration_seconds histogram');
    for (const m of this.httpStats.values()) {
      for (let i = 0; i < HISTOGRAM_BUCKETS_SECONDS.length; i += 1) {
        const le = HISTOGRAM_BUCKETS_SECONDS[i]!;
        lines.push(
          `request_duration_seconds_bucket${labels({ method: m.method, route: m.route, status_class: m.statusClass, le })} ${m.durationBuckets[i] ?? 0}`,
        );
      }
      lines.push(
        `request_duration_seconds_bucket${labels({ method: m.method, route: m.route, status_class: m.statusClass, le: '+Inf' })} ${m.durationCount}`,
      );
      lines.push(
        `request_duration_seconds_sum${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.durationSumSeconds.toFixed(6)}`,
      );
      lines.push(
        `request_duration_seconds_count${labels({ method: m.method, route: m.route, status_class: m.statusClass })} ${m.durationCount}`,
      );
    }

    // Codex Round 5 P1 fix: end-to-end turn duration histogram (separate
    // from the HTTP histogram, with a wider tail to support the p99 ≤ 30s SLO).
    lines.push(
      '# HELP turn_duration_seconds End-to-end turn duration in seconds (post-cascade, post-tools).',
    );
    lines.push('# TYPE turn_duration_seconds histogram');
    for (let i = 0; i < TURN_HISTOGRAM_BUCKETS_SECONDS.length; i += 1) {
      const le = TURN_HISTOGRAM_BUCKETS_SECONDS[i]!;
      lines.push(
        `turn_duration_seconds_bucket${labels({ le })} ${this.turnDurationBuckets[i] ?? 0}`,
      );
    }
    lines.push(
      `turn_duration_seconds_bucket${labels({ le: '+Inf' })} ${this.turnDurationCount}`,
    );
    lines.push(`turn_duration_seconds_sum ${this.turnDurationSumSeconds.toFixed(6)}`);
    lines.push(`turn_duration_seconds_count ${this.turnDurationCount}`);

    lines.push(
      '# HELP chain_blocks_total Total number of chain blocks discovered in scanned chain JSON files.',
    );
    lines.push('# TYPE chain_blocks_total gauge');
    lines.push(`chain_blocks_total ${this.chainBlocksTotal}`);

    lines.push('# HELP chain_size_bytes Total size in bytes for scanned chain JSON files.');
    lines.push('# TYPE chain_size_bytes gauge');
    lines.push(`chain_size_bytes ${this.chainSizeBytes}`);

    lines.push('# HELP embed_queries_total Total number of embedding search queries.');
    lines.push('# TYPE embed_queries_total counter');
    lines.push(`embed_queries_total ${this.embedQueriesTotal}`);

    lines.push(
      '# HELP embed_cache_hits_total Total number of embedding queries with at least one result.',
    );
    lines.push('# TYPE embed_cache_hits_total counter');
    lines.push(`embed_cache_hits_total ${this.embedCacheHitsTotal}`);

    lines.push(
      '# HELP embed_cache_misses_total Total number of embedding queries with zero results.',
    );
    lines.push('# TYPE embed_cache_misses_total counter');
    lines.push(`embed_cache_misses_total ${this.embedCacheMissesTotal}`);

    lines.push('# HELP ask_requests_total Total number of ask/generate requests by provider.');
    lines.push('# TYPE ask_requests_total counter');
    for (const [provider, count] of this.askRequestsByProvider.entries()) {
      lines.push(`ask_requests_total${labels({ provider })} ${count}`);
    }

    lines.push('# HELP ask_request_duration_seconds Total ask latency in seconds by provider.');
    lines.push('# TYPE ask_request_duration_seconds summary');
    for (const [provider, value] of this.askLatencyByProvider.entries()) {
      lines.push(
        `ask_request_duration_seconds_sum${labels({ provider })} ${value.sumSeconds.toFixed(6)}`,
      );
      lines.push(`ask_request_duration_seconds_count${labels({ provider })} ${value.count}`);
    }

    lines.push('# HELP queue_overload_total Total number of queue overload rejections (HTTP 429).');
    lines.push('# TYPE queue_overload_total counter');
    lines.push(`queue_overload_total ${this.queueOverloadTotal}`);

    lines.push('# HELP safe_mode_denials_total Total number of requests denied by safe mode.');
    lines.push('# TYPE safe_mode_denials_total counter');
    lines.push(`safe_mode_denials_total ${this.safeModeDenialsTotal}`);

    lines.push(
      '# HELP safe_mode_denial_route_total Total number of safe mode denials by route and method.',
    );
    lines.push('# TYPE safe_mode_denial_route_total counter');
    for (const m of this.safeModeDenialStats.values()) {
      lines.push(
        `safe_mode_denial_route_total${labels({ method: m.method, route: m.route })} ${m.count}`,
      );
    }

    lines.push(
      '# HELP dual_approval_transitions_total Total number of dual approval lifecycle transitions.',
    );
    lines.push('# TYPE dual_approval_transitions_total counter');
    lines.push(`dual_approval_transitions_total ${this.dualApprovalTransitionsTotal}`);

    lines.push(
      '# HELP dual_approval_transition_state_total Total dual approval transitions by action and to_state.',
    );
    lines.push('# TYPE dual_approval_transition_state_total counter');
    for (const m of this.dualApprovalTransitionStats.values()) {
      lines.push(
        `dual_approval_transition_state_total${labels({ action: m.action, to_state: m.toState })} ${m.count}`,
      );
    }

    lines.push('# HELP model_d_proposals_total Total number of Model D proposals received.');
    lines.push('# TYPE model_d_proposals_total counter');
    lines.push(`model_d_proposals_total ${this.modelDProposalsTotal}`);

    lines.push('# HELP model_d_proposals_by_vote_total Model D proposals by vote outcome.');
    lines.push('# TYPE model_d_proposals_by_vote_total counter');
    for (const m of this.modelDProposalsByVote.values()) {
      lines.push(`model_d_proposals_by_vote_total${labels({ vote: m.vote })} ${m.count}`);
    }

    lines.push('# HELP model_d_proposal_duration_seconds Model D proposal handling latency.');
    lines.push('# TYPE model_d_proposal_duration_seconds summary');
    lines.push(`model_d_proposal_duration_seconds_sum ${this.modelDLatencySumSeconds.toFixed(6)}`);
    lines.push(`model_d_proposal_duration_seconds_count ${this.modelDLatencyCount}`);

    lines.push('# HELP schedule_jobs_created_total Total scheduled jobs created.');
    lines.push('# TYPE schedule_jobs_created_total counter');
    lines.push(`schedule_jobs_created_total ${this.scheduleJobsCreated}`);

    lines.push('# HELP schedule_jobs_completed_total Total scheduled jobs completed.');
    lines.push('# TYPE schedule_jobs_completed_total counter');
    lines.push(`schedule_jobs_completed_total ${this.scheduleJobsCompleted}`);

    lines.push('# HELP schedule_jobs_failed_total Total scheduled jobs failed.');
    lines.push('# TYPE schedule_jobs_failed_total counter');
    lines.push(`schedule_jobs_failed_total ${this.scheduleJobsFailed}`);

    lines.push('# HELP schedule_jobs_canceled_total Total scheduled jobs canceled.');
    lines.push('# TYPE schedule_jobs_canceled_total counter');
    lines.push(`schedule_jobs_canceled_total ${this.scheduleJobsCanceled}`);

    lines.push('# HELP scheduler_runtime_target Current scheduler execution target by phase.');
    lines.push('# TYPE scheduler_runtime_target gauge');
    for (const phase of ['configured', 'effective'] as const) {
      const selected =
        phase === 'configured' ? this.schedulerConfiguredTarget : this.schedulerEffectiveTarget;
      for (const target of ['local', 'workers'] as const) {
        lines.push(
          `scheduler_runtime_target${labels({ phase, target })} ${selected === target ? 1 : 0}`,
        );
      }
    }

    lines.push('# HELP scheduler_runtime_running Whether the scheduler loop is active.');
    lines.push('# TYPE scheduler_runtime_running gauge');
    lines.push(`scheduler_runtime_running ${this.schedulerRunning ? 1 : 0}`);

    lines.push('# HELP scheduler_worker_lane_ready Whether the scheduler can use worker execution.');
    lines.push('# TYPE scheduler_worker_lane_ready gauge');
    lines.push(
      `scheduler_worker_lane_ready ${this.schedulerWorkerLaneReady === true ? 1 : 0}`,
    );

    lines.push('# HELP scheduler_worker_lane_ready_known Whether worker-lane readiness is known.');
    lines.push('# TYPE scheduler_worker_lane_ready_known gauge');
    lines.push(
      `scheduler_worker_lane_ready_known ${this.schedulerWorkerLaneReady === null ? 0 : 1}`,
    );

    lines.push(
      '# HELP scheduler_fallback_active Whether the scheduler is currently falling back from workers to local execution.',
    );
    lines.push('# TYPE scheduler_fallback_active gauge');
    lines.push(`scheduler_fallback_active ${this.schedulerFallbackActive ? 1 : 0}`);

    lines.push(
      '# HELP scheduler_fallback_total Total number of scheduler worker-to-local fallback activations observed.',
    );
    lines.push('# TYPE scheduler_fallback_total counter');
    lines.push(`scheduler_fallback_total ${this.schedulerFallbacksTotal}`);

    lines.push('# HELP scheduler_tasks_total Total number of configured scheduler tasks.');
    lines.push('# TYPE scheduler_tasks_total gauge');
    lines.push(`scheduler_tasks_total ${this.schedulerTasksTotal}`);

    lines.push('# HELP scheduler_tasks_enabled Total number of enabled scheduler tasks.');
    lines.push('# TYPE scheduler_tasks_enabled gauge');
    lines.push(`scheduler_tasks_enabled ${this.schedulerTasksEnabled}`);

    lines.push('# HELP scheduler_tasks_overdue Total number of overdue enabled scheduler tasks.');
    lines.push('# TYPE scheduler_tasks_overdue gauge');
    lines.push(`scheduler_tasks_overdue ${this.schedulerTasksOverdue}`);

    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new InMemoryMetrics();
