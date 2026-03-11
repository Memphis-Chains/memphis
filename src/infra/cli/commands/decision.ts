import { createHash } from 'node:crypto';

import { AgentRegistry as CognitiveAgentRegistry } from '../../../cognitive/agent-registry.js';
import { DecisionInference } from '../../../cognitive/decision-inference.js';
import { RelationshipGraph } from '../../../cognitive/relationship-graph.js';
import { TrustMetrics } from '../../../cognitive/trust-metrics.js';
import { appendDecisionAudit, readDecisionAudit } from '../../../core/decision-audit-log.js';
import { inferDecisionFromText } from '../../../core/decision-gate.js';
import {
  appendDecisionHistory,
  readDecisionHistory,
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
    trust: handleTrustCommand,
    decide: handleDecideCommand,
  };
  const handler = command ? handlers[command] : undefined;
  return handler ? handler(context) : false;
}

async function handlePredictCommand(context: CliContext): Promise<boolean> {
  const engine = createDecisionInference(context);
  print(
    {
      ok: true,
      mode: 'predict',
      prediction: await engine.predictNextDecision(),
      backtestAccuracy: engine.evaluatePredictionAccuracy(20),
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
      mode: 'git-stats',
      sinceDays,
      stats: createDecisionInference(context).getGitStats(sinceDays),
    },
    context.args.json,
  );
  return true;
}

async function handleInferCommand(context: CliContext): Promise<boolean> {
  if (!context.args.input) {
    const sinceDays = context.args.days ?? 7;
    print(
      {
        ok: true,
        mode: 'infer-git',
        sinceDays,
        inferred: await createDecisionInference(context).inferFromGit(sinceDays),
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

async function handleTrustCommand(context: CliContext): Promise<boolean> {
  const did = context.args.subcommand ?? context.args.target ?? context.args.id;
  if (!did) throw new Error('trust requires <did> or --id <did>');
  print(
    { ok: true, mode: 'trust', did, score: new TrustMetrics().calculateGlobalTrust(did) },
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
    ? readDecisionHistory().filter((e) => e.decision.id === context.args.id)
    : readDecisionHistory();
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
  const historyPath = appendDecisionHistory(next, {
    correlationId,
    chainRef: {
      chain: 'decision-audit',
      index: readDecisionAudit().length,
      hash: buildTransitionHash(audit.eventId, record, to, next.updatedAt, correlationId),
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
      historyPath,
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

function createDecisionInference(context: CliContext): DecisionInference {
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
