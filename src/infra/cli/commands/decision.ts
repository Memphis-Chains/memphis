import { createHash } from 'node:crypto';
import { appendDecisionAudit, readDecisionAudit } from '../../../core/decision-audit-log.js';
import { appendDecisionHistory, readDecisionHistory } from '../../../core/decision-history-store.js';
import { transitionDecision, type DecisionRecord, type DecisionStatus } from '../../../core/decision-lifecycle.js';
import { inferDecisionFromText } from '../../../core/decision-gate.js';
import { DecisionInference } from '../../../cognitive/decision-inference.js';
import { AgentRegistry as CognitiveAgentRegistry } from '../../../cognitive/agent-registry.js';
import { RelationshipGraph } from '../../../cognitive/relationship-graph.js';
import { TrustMetrics } from '../../../cognitive/trust-metrics.js';
import { SyncAgentRegistry } from '../../../sync/agent-registry.js';
import { print } from '../utils/render.js';
import type { CliContext } from '../context.js';

export async function handleDecisionCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const { command, subcommand, json, repoPath, days, input, id, latest, to, target } = args;

  if (command === 'predict') {
    const engine = new DecisionInference({ repoPath: repoPath ?? process.cwd() });
    print({ ok: true, mode: 'predict', prediction: await engine.predictNextDecision(), backtestAccuracy: engine.evaluatePredictionAccuracy(20) }, json);
    return true;
  }

  if (command === 'git-stats') {
    const engine = new DecisionInference({ repoPath: repoPath ?? process.cwd() });
    print({ ok: true, mode: 'git-stats', sinceDays: days ?? 7, stats: engine.getGitStats(days ?? 7) }, json);
    return true;
  }

  if (command === 'infer' && !input) {
    const engine = new DecisionInference({ repoPath: repoPath ?? process.cwd() });
    print({ ok: true, mode: 'infer-git', sinceDays: days ?? 7, inferred: await engine.inferFromGit(days ?? 7) }, json);
    return true;
  }

  if (command === 'agents') {
    const syncRegistry = new SyncAgentRegistry();

    if (subcommand === 'list') {
      const agents = syncRegistry.list();
      print({ ok: true, mode: 'agents-list', count: agents.length, agents }, json);
      return true;
    }

    if (subcommand === 'discover') {
      const agents = syncRegistry.discover();
      print({ ok: true, mode: 'agents-discover', count: agents.length, agents }, json);
      return true;
    }

    if (subcommand === 'show') {
      const did = target ?? id;
      if (!did) throw new Error('agents show requires <did> or --id <did>');
      const found = new CognitiveAgentRegistry().getAgent(did);
      if (!found) throw new Error(`agent not found: ${did}`);
      print({ ok: true, mode: 'agents-show', agent: found }, json);
      return true;
    }

    throw new Error(`Unknown agents subcommand: ${String(subcommand)}`);
  }

  if (command === 'relationships') {
    if (subcommand !== 'show') throw new Error(`Unknown relationships subcommand: ${String(subcommand)}`);
    const did = target ?? id;
    if (!did) throw new Error('relationships show requires <did> or --id <did>');
    const relationships = new RelationshipGraph(new CognitiveAgentRegistry()).listByAgent(did);
    print({ ok: true, mode: 'relationships-show', did, count: relationships.length, relationships }, json);
    return true;
  }

  if (command === 'trust') {
    const did = subcommand ?? target ?? id;
    if (!did) throw new Error('trust requires <did> or --id <did>');
    print({ ok: true, mode: 'trust', did, score: new TrustMetrics().calculateGlobalTrust(did) }, json);
    return true;
  }

  if (command === 'decide' || command === 'infer') {
    if (command === 'decide' && subcommand === 'history') {
      const filtered = id ? readDecisionHistory().filter((e) => e.decision.id === id) : readDecisionHistory();
      const entries = latest && Number.isFinite(latest) && latest > 0 ? filtered.slice(-Math.trunc(latest)) : filtered;
      print(
        {
          ok: true,
          entries,
          count: entries.length,
          filter: id ? { id } : undefined,
          latest: latest && Number.isFinite(latest) && latest > 0 ? Math.trunc(latest) : undefined,
        },
        json,
      );
      return true;
    }

    if (command === 'decide' && subcommand === 'transition') {
      if (!input || !to) throw new Error('decide transition requires --input <DecisionRecord JSON> and --to <status>');
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
      const deterministicHash = createHash('sha256')
        .update(
          JSON.stringify({
            eventId: audit.eventId,
            id: record.id,
            from: record.status,
            to,
            updatedAt: next.updatedAt,
            correlationId,
          }),
        )
        .digest('hex');

      const historyPath = appendDecisionHistory(next, {
        correlationId,
        chainRef: {
          chain: 'decision-audit',
          index: readDecisionAudit().length,
          hash: deterministicHash,
        },
      });
      print({ ok: true, mode: 'decide-transition', from: record.status, to, decision: next, audit, historyPath }, json);
      return true;
    }

    if (!input || input.trim().length === 0) throw new Error(`Missing required --input for ${command} command`);
    const signal = inferDecisionFromText(input);
    if (command === 'decide' && signal.detected) {
      appendDecisionAudit({
        ts: new Date().toISOString(),
        decisionId: `detected-${Date.now()}`,
        action: 'create',
        actor: 'cli',
        note: signal.reason,
      });
    }
    print({ ok: true, mode: command, signal }, json);
    return true;
  }

  return false;
}
