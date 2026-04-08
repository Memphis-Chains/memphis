import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadCognitiveConfig } from '../../cognitive/config-loader.js';
import { InsightGenerator } from '../../cognitive/insight-generator.js';
import { ModelE_MetaCognitiveReflection } from '../../cognitive/model-e.js';
import type { Reflection } from '../../cognitive/types.js';
import { getDataDir } from '../../config/paths.js';
import type { Block } from '../../memory/chain.js';
import { updateSoulMemory, writeMemoryAction } from '../../soul/memory.js';
import { loadCognitiveBlocks } from '../cli/utils/cognitive.js';
import { createPinoLogger } from '../logging/pino.js';

export const DEFAULT_REFLECTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REFLECTION_INITIAL_DELAY_MS = 5 * 60 * 1000;

type ReflectionPeriod = 'daily' | 'weekly';
type ReflectionTrigger = 'lifecycle' | 'scheduler';

export interface ReflectionLoopState {
  lastDailyRunAt?: string;
  lastWeeklyRunAt?: string;
  lastRunAt?: string;
}

export interface ReflectionRunSummary {
  generatedAt: string;
  trigger: ReflectionTrigger;
  periods: ReflectionPeriod[];
  reflectionCount: number;
  insightCount: number;
  recentDecisionCount: number;
  soulMemoryUpdated: boolean;
  skipped: boolean;
  skippedReason?: 'not-due';
}

export interface RunReflectionCycleOptions {
  rawEnv?: NodeJS.ProcessEnv;
  now?: Date;
  periods?: ReflectionPeriod[];
  trigger?: ReflectionTrigger;
}

export interface RunDueReflectionCycleOptions {
  rawEnv?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface ReflectionLoopOptions {
  rawEnv?: NodeJS.ProcessEnv;
  intervalMs?: number;
  initialDelayMs?: number;
  runCycle?: () => Promise<ReflectionRunSummary>;
}

const reflectionLoopLog = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export function getReflectionLoopStatePath(_rawEnv: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(_rawEnv), 'config', 'reflection-loop-state.json');
}

export function loadReflectionLoopState(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ReflectionLoopState {
  const statePath = getReflectionLoopStatePath(rawEnv);
  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as ReflectionLoopState;
    return {
      lastDailyRunAt:
        typeof raw.lastDailyRunAt === 'string' && raw.lastDailyRunAt.length > 0
          ? raw.lastDailyRunAt
          : undefined,
      lastWeeklyRunAt:
        typeof raw.lastWeeklyRunAt === 'string' && raw.lastWeeklyRunAt.length > 0
          ? raw.lastWeeklyRunAt
          : undefined,
      lastRunAt:
        typeof raw.lastRunAt === 'string' && raw.lastRunAt.length > 0 ? raw.lastRunAt : undefined,
    };
  } catch {
    return {};
  }
}

export function saveReflectionLoopState(
  state: ReflectionLoopState,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const statePath = getReflectionLoopStatePath(rawEnv);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export function reflectionLoopEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const value = rawEnv.MEMPHIS_REFLECTION_ENABLED?.trim().toLowerCase();
  if (!value) {
    return true;
  }
  return value === 'true';
}

export function resolveReflectionIntervalMs(rawEnv: NodeJS.ProcessEnv = process.env): number {
  const raw = rawEnv.MEMPHIS_REFLECTION_INTERVAL_MS?.trim();
  if (!raw) {
    return DEFAULT_REFLECTION_INTERVAL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 3_600_000
    ? parsed
    : DEFAULT_REFLECTION_INTERVAL_MS;
}

export function resolveReflectionInitialDelayMs(
  rawEnv: NodeJS.ProcessEnv = process.env,
): number {
  return Math.min(resolveReflectionIntervalMs(rawEnv), DEFAULT_REFLECTION_INITIAL_DELAY_MS);
}

export function resolveDueReflectionPeriods(
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  state: ReflectionLoopState = loadReflectionLoopState(rawEnv),
): ReflectionPeriod[] {
  const config = loadCognitiveConfig(rawEnv).modelE;
  const periods: ReflectionPeriod[] = [];

  if (config.reflectionSchedule !== 'weekly' && shouldRunDailyReflection(now, state)) {
    periods.push('daily');
  }

  if (config.reflectionSchedule !== 'daily' && shouldRunWeeklyReflection(now, state, config.deepAnalysisDay)) {
    periods.push('weekly');
  }

  return periods;
}

export async function runReflectionCycle(
  options: RunReflectionCycleOptions = {},
): Promise<ReflectionRunSummary> {
  const rawEnv = options.rawEnv ?? process.env;
  const now = options.now ?? new Date();
  const periods = dedupePeriods(options.periods ?? ['daily']);
  if (periods.length === 0) {
    return buildSkippedSummary(options.trigger ?? 'lifecycle', now, 'not-due');
  }

  const blocks = await loadCognitiveBlocks({}, rawEnv);
  const modelEConfig = loadCognitiveConfig(rawEnv).modelE;
  const model = new ModelE_MetaCognitiveReflection(blocks, modelEConfig);
  const insightGenerator = new InsightGenerator(blocks);
  const reflections: Reflection[] = [];
  let insightCount = 0;

  for (const period of periods) {
    if (period === 'daily') {
      reflections.push(await model.dailyPersisted());
      insightCount += (await insightGenerator.generateDailyInsights()).length;
      continue;
    }

    reflections.push(await model.weeklyPersisted());
    insightCount += (await insightGenerator.generateWeeklyInsights()).length;
  }

  const recentDecisions = collectRecentDecisions(blocks);
  updateSoulMemory(
    {
      self: {
        learnings: collectReflectionLearnings(reflections),
        evolvedCapabilities: dedupeText([
          ...periods.map((period) => `${period} self-reflection`),
          'autonomous insight synthesis',
        ]),
      },
      context: {
        recentDecisions,
      },
    },
    rawEnv,
  );

  writeMemoryAction(
    'insight',
    `${options.trigger ?? 'lifecycle'} reflection cycle: ${periods.join(', ')} | reflections=${reflections.length} insights=${insightCount}`,
    rawEnv,
  );

  return {
    generatedAt: now.toISOString(),
    trigger: options.trigger ?? 'lifecycle',
    periods,
    reflectionCount: reflections.length,
    insightCount,
    recentDecisionCount: recentDecisions.length,
    soulMemoryUpdated: true,
    skipped: false,
  };
}

export async function runDueReflectionCycle(
  options: RunDueReflectionCycleOptions = {},
): Promise<ReflectionRunSummary> {
  const rawEnv = options.rawEnv ?? process.env;
  const now = options.now ?? new Date();
  const state = loadReflectionLoopState(rawEnv);
  const periods = resolveDueReflectionPeriods(rawEnv, now, state);

  if (periods.length === 0) {
    return buildSkippedSummary('lifecycle', now, 'not-due');
  }

  const result = await runReflectionCycle({
    rawEnv,
    now,
    periods,
    trigger: 'lifecycle',
  });

  const nextState: ReflectionLoopState = {
    ...state,
    lastRunAt: now.toISOString(),
  };

  if (periods.includes('daily')) {
    nextState.lastDailyRunAt = now.toISOString();
  }
  if (periods.includes('weekly')) {
    nextState.lastWeeklyRunAt = now.toISOString();
  }

  saveReflectionLoopState(nextState, rawEnv);
  return result;
}

export class ReflectionLoop {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rawEnv: NodeJS.ProcessEnv;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly runCycle: () => Promise<ReflectionRunSummary>;

  constructor(options: ReflectionLoopOptions = {}) {
    this.rawEnv = options.rawEnv ?? process.env;
    this.intervalMs = options.intervalMs ?? resolveReflectionIntervalMs(this.rawEnv);
    this.initialDelayMs = options.initialDelayMs ?? resolveReflectionInitialDelayMs(this.rawEnv);
    this.runCycle = options.runCycle ?? (() => runDueReflectionCycle({ rawEnv: this.rawEnv }));
  }

  start(): boolean {
    if (this.startupTimer || this.intervalTimer) {
      return true;
    }

    if (!reflectionLoopEnabled(this.rawEnv)) {
      reflectionLoopLog.info('self-reflection loop disabled by MEMPHIS_REFLECTION_ENABLED=false');
      return false;
    }

    reflectionLoopLog.info(
      {
        initialDelayMs: this.initialDelayMs,
        intervalMs: this.intervalMs,
      },
      'starting self-reflection lifecycle loop',
    );

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick();
      this.intervalTimer = setInterval(() => void this.tick(), this.intervalMs);
      this.intervalTimer.unref?.();
    }, this.initialDelayMs);
    this.startupTimer.unref?.();
    return true;
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  async runOnce(): Promise<ReflectionRunSummary> {
    return this.runCycle();
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runCycle();
      if (result.skipped) {
        reflectionLoopLog.info(
          {
            reason: result.skippedReason,
            generatedAt: result.generatedAt,
          },
          'self-reflection loop tick skipped',
        );
        return;
      }

      reflectionLoopLog.info(
        {
          generatedAt: result.generatedAt,
          periods: result.periods,
          reflections: result.reflectionCount,
          insights: result.insightCount,
          recentDecisions: result.recentDecisionCount,
        },
        'self-reflection loop tick completed',
      );
    } catch (error) {
      reflectionLoopLog.warn({ err: error }, 'self-reflection loop tick failed');
    }
  }
}

export function startReflectionLoop(options: ReflectionLoopOptions = {}): ReflectionLoop {
  const loop = new ReflectionLoop(options);
  loop.start();
  return loop;
}

function buildSkippedSummary(
  trigger: ReflectionTrigger,
  now: Date,
  reason: 'not-due',
): ReflectionRunSummary {
  return {
    generatedAt: now.toISOString(),
    trigger,
    periods: [],
    reflectionCount: 0,
    insightCount: 0,
    recentDecisionCount: 0,
    soulMemoryUpdated: false,
    skipped: true,
    skippedReason: reason,
  };
}

function shouldRunDailyReflection(now: Date, state: ReflectionLoopState): boolean {
  return isRunBeforeBoundary(state.lastDailyRunAt, startOfUtcDay(now));
}

function shouldRunWeeklyReflection(
  now: Date,
  state: ReflectionLoopState,
  deepAnalysisDay: number,
): boolean {
  return isRunBeforeBoundary(
    state.lastWeeklyRunAt,
    latestUtcWeekBoundary(now, normalizeDeepAnalysisDay(deepAnalysisDay)),
  );
}

function isRunBeforeBoundary(lastRunAt: string | undefined, boundary: Date): boolean {
  if (!lastRunAt) {
    return true;
  }

  const parsed = Date.parse(lastRunAt);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return parsed < boundary.getTime();
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function latestUtcWeekBoundary(now: Date, deepAnalysisDay: number): Date {
  const boundary = startOfUtcDay(now);
  const delta = (boundary.getUTCDay() - deepAnalysisDay + 7) % 7;
  boundary.setUTCDate(boundary.getUTCDate() - delta);
  return boundary;
}

function normalizeDeepAnalysisDay(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const normalized = Math.trunc(value) % 7;
  return normalized >= 0 ? normalized : normalized + 7;
}

function collectRecentDecisions(blocks: Block[]): string[] {
  return dedupeText(
    blocks
      .filter(
        (block) =>
          block.chain === 'decisions' || (typeof block.data?.type === 'string' && block.data.type === 'decision'),
      )
      .map((block) => (typeof block.data?.content === 'string' ? block.data.content.trim() : ''))
      .filter((content) => content.length > 0)
      .slice(-5),
  );
}

function collectReflectionLearnings(reflections: Reflection[]): string[] {
  return dedupeText(
    reflections.flatMap((reflection) => [
      ...reflection.insights.slice(0, 3).map((insight) => insight.description.trim()),
      ...reflection.recommendations.slice(0, 3).map((recommendation) => recommendation.trim()),
    ]),
  ).slice(0, 8);
}

function dedupePeriods(periods: ReflectionPeriod[]): ReflectionPeriod[] {
  return Array.from(new Set(periods));
}

function dedupeText(entries: string[]): string[] {
  return Array.from(
    new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
  );
}
