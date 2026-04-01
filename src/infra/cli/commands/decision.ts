import { createHash } from 'node:crypto';

import { AgentRegistry as CognitiveAgentRegistry } from '../../../cognitive/agent-registry.js';
import { loadCognitiveConfig } from '../../../cognitive/config-loader.js';
import { DecisionInference } from '../../../cognitive/decision-inference.js';
import { ModelB_InferredDecisions } from '../../../cognitive/model-b.js';
import { ModelC_PredictivePatterns } from '../../../cognitive/model-c.js';
import { RelationshipGraph } from '../../../cognitive/relationship-graph.js';
import { loadCognitiveBlocks } from '../../../cognitive/runtime-support.js';
import { appendDecisionAudit } from '../../../core/decision-audit-log.js';
import { inferDecisionFromText } from '../../../core/decision-gate.js';
import {
  recordDecisionHistoryEntry,
  readCanonicalDecisionHistory,
} from '../../../core/decision-history-store.js';
import {
  type DecisionRecord,
  type DecisionStatus,
  transitionDecision,
} from '../../../core/decision-lifecycle.js';
import { SyncAgentRegistry } from '../../../sync/agent-registry.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type DecisionHandler = (context: CliContext) => Promise<boolean>;

export async function handleDecisionCommand(context: CliContext): Promise<boolean> {
  const command = context.args.command;
  const handlers: Partial<Record<string, DecisionHandler>> = {
    predict: handlePredictCommand,
    'git-stats': handleGitStatsCommand,
    infer: handleInferCommand,
    agents: handleAgentsCommand,
    relationships: handleRelationshipsCommand,
    decide: handleDecideCommand,
  };
  const handler = command ? handlers[command] : undefined;
  return handler ? handler(context) : false;
}

async function handlePredictCommand(context: CliContext): Promise<boolean> {
  const cognitiveConfig = loadCognitiveConfig();
  const blocks = await loadCognitiveBlocks();
  const learner = new ModelC_PredictivePatterns(blocks, cognitiveConfig.modelC);
  await learner.learn();
  const predictions = learner.predict(buildPredictionContext(blocks)).slice(0, 3);
  const top = predictions[0];
  print(
    {
      ok: true,
      mode: 'predict-chain',
      prediction: top
        ? {
            type: top.type,
            title: top.title,
            confidence: top.confidence,
            rationale: top.reasoning ?? 'Derived from chain-first cognitive patterns.',
            evidence: top.evidence,
          }
        : {
            type: 'unknown',
            title: 'No stable chain pattern yet',
            confidence: 0,
            rationale: 'Not enough local chain history to predict the next decision.',
            evidence: [],
          },
      predictions,
      backtestAccuracy: top ? Number(top.confidence.toFixed(3)) : 0,
    },
    context.args.json,
  );
  return true;
}

async function handleGitStatsCommand(context: CliContext): Promise<boolean> {
  const sinceDays = context.args.days ?? 7;
  print(
    {
      ok: true,
      mode: 'git-stats-legacy',
      lane: 'legacy-git-debug',
      scope: 'debug',
      deprecated: true,
      sourceOfTruth: 'chains',
      note:
        'Git stats summarize repo history for debug/review only. They do not drive Memphis runtime cognition.',
      sinceDays,
      stats: createLegacyDecisionInference(context).getGitStats(sinceDays),
    },
    context.args.json,
  );
  return true;
}

async function handleInferCommand(context: CliContext): Promise<boolean> {
  const cognitiveConfig = loadCognitiveConfig();
  if (!context.args.input) {
    const inferred = new ModelB_InferredDecisions(cognitiveConfig.modelB).inferFromChainHistory(await loadCognitiveBlocks());
    print(
      {
        ok: true,
        mode: 'infer-chain',
        count: inferred.length,
        inferred,
      },
      context.args.json,
    );
    return true;
  }
  return handleDecisionSignal(context, 'infer');
}

async function handleAgentsCommand(context: CliContext): Promise<boolean> {
  const { subcommand, json } = context.args;
  const syncRegistry = new SyncAgentRegistry();
  const handlers: Record<string, () => boolean> = {
    list: () => {
      const agents = syncRegistry.list();
      print({ ok: true, mode: 'agents-list', count: agents.length, agents }, json);
      return true;
    },
    discover: () => {
      const agents = syncRegistry.discover();
      print({ ok: true, mode: 'agents-discover', count: agents.length, agents }, json);
      return true;
    },
    show: () => {
      const did = requireDid(context, 'agents show requires <did> or --id <did>');
      const found = new CognitiveAgentRegistry().getAgent(did);
      if (!found) throw new Error(`agent not found: ${did}`);
      print({ ok: true, mode: 'agents-show', agent: found }, json);
      return true;
    },
  };
  const handler = subcommand ? handlers[subcommand] : undefined;
  if (!handler) throw new Error(`Unknown agents subcommand: ${String(subcommand)}`);
  return handler();
}

async function handleRelationshipsCommand(context: CliContext): Promise<boolean> {
  if (context.args.subcommand !== 'show')
    throw new Error(`Unknown relationships subcommand: ${String(context.args.subcommand)}`);
  const did = requireDid(context, 'relationships show requires <did> or --id <did>');
  const relationships = new RelationshipGraph(new CognitiveAgentRegistry()).listByAgent(did);
  print(
    { ok: true, mode: 'relationships-show', did, count: relationships.length, relationships },
    context.args.json,
  );
  return true;
}

async function handleDecideCommand(context: CliContext): Promise<boolean> {
  if (context.args.subcommand === 'history') return handleDecisionHistory(context);
  if (context.args.subcommand === 'transition') return handleDecisionTransition(context);
  return handleDecisionSignal(context, 'decide');
}

async function handleDecisionHistory(context: CliContext): Promise<boolean> {
  const filtered = context.args.id
    ? (await readCanonicalDecisionHistory()).filter((e) => e.decision.id === context.args.id)
    : await readCanonicalDecisionHistory();
  const latest = normalizeLatest(context.args.latest);
  const entries = latest ? filtered.slice(-latest) : filtered;
  print(
    {
      ok: true,
      entries,
      count: entries.length,
      filter: context.args.id ? { id: context.args.id } : undefined,
      latest,
    },
    context.args.json,
  );
  return true;
}

async function handleDecisionTransition(context: CliContext): Promise<boolean> {
  const { input, to, json } = context.args;
  if (!input || !to)
    throw new Error('decide transition requires --input <DecisionRecord JSON> and --to <status>');
  const record = JSON.parse(input) as DecisionRecord;
  const next = transitionDecision(record, to as DecisionStatus);
  const correlationId = `${record.id}:${Date.now()}`;
  const audit = appendDecisionAudit({
    ts: new Date().toISOString(),
    decisionId: record.id,
    action: 'transition',
    from: record.status,
    to,
    actor: 'cli',
    correlationId,
  });
  const auditHash = buildTransitionHash(audit.eventId, record, to, next.updatedAt, correlationId);
  const historyEntry = await recordDecisionHistoryEntry(next, {
    correlationId,
    source: 'cli',
    fallbackTags: ['decision', 'transition', `status:${to}`],
    extraData: {
      content: `${next.title} -> ${to}`,
      transitionFrom: record.status,
      transitionTo: to,
      auditEventId: audit.eventId,
      auditHash,
      refs: Array.from(new Set([...(next.refs ?? []), `audit:${audit.eventId}`, `audit-hash:${auditHash}`])),
    },
  });
  print(
    {
      ok: true,
      mode: 'decide-transition',
      from: record.status,
      to,
      decision: next,
      audit,
      decisionChainRef: historyEntry.chainRef,
    },
    json,
  );
  return true;
}

async function handleDecisionSignal(
  context: CliContext,
  mode: 'decide' | 'infer',
): Promise<boolean> {
  const input = context.args.input;
  if (!input || input.trim().length === 0)
    throw new Error(`Missing required --input for ${mode} command`);
  const signal = inferDecisionFromText(input);
  if (mode === 'decide' && signal.detected) appendDetectedDecisionAudit(signal.reason);
  print({ ok: true, mode, signal }, context.args.json);
  return true;
}

function buildPredictionContext(
  blocks: Awaited<ReturnType<typeof loadCognitiveBlocks>>,
): {
  timeOfDay: number;
  dayOfWeek: number;
  recentDecisions: number;
  tags: string[];
  chain: string;
} {
  const now = new Date();
  const tagFrequency = new Map<string, number>();

  for (const block of blocks.slice(-40)) {
    for (const tag of block.data?.tags ?? []) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
  }

  const tags = Array.from(tagFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag]) => tag);

  return {
    timeOfDay: now.getHours(),
    dayOfWeek: now.getDay(),
    recentDecisions: blocks.filter((block) => block.data?.type === 'decision').length,
    tags,
    chain: 'decisions',
  };
}

function createLegacyDecisionInference(context: CliContext): DecisionInference {
  return new DecisionInference({ repoPath: context.args.repoPath ?? process.cwd() });
}

function requireDid(context: CliContext, message: string): string {
  const did = context.args.target ?? context.args.id;
  if (!did) throw new Error(message);
  return did;
}

function normalizeLatest(latest: number | undefined): number | undefined {
  return latest && Number.isFinite(latest) && latest > 0 ? Math.trunc(latest) : undefined;
}

function buildTransitionHash(
  eventId: string,
  record: DecisionRecord,
  to: string,
  updatedAt: string,
  correlationId: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ eventId, id: record.id, from: record.status, to, updatedAt, correlationId }),
    )
    .digest('hex');
}

function appendDetectedDecisionAudit(reason: string | undefined): void {
  appendDecisionAudit({
    ts: new Date().toISOString(),
    decisionId: `detected-${Date.now()}`,
    action: 'create',
    actor: 'cli',
    note: reason,
  });
}
