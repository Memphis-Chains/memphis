/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
import type { CommandHandler } from './command-handler.js';
import { createInProcessMemoryClient } from '../../../gateway/memory-client.js';
import { createInProcessToolExecutor } from '../../../gateway/tool-executor.js';
import { getLocalWorkerRuntimeStatus } from '../../runtime/local-worker-state.js';
import { CaseChainAdapter } from '../../storage/case-chain-adapter.js';
import { LocalWorkerRunner } from '../../work/local-worker-runner.js';
import { DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE } from '../../work/work-capabilities.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function buildRuntime(context: CliContext) {
  const container = context.getContainer();
  return {
    // CLI worker processes `chat.generate` queue items — these are
    // HTTP-originated chat turns executed out-of-band (see
    // `executeChatGenerateWork` in local-worker-runner.ts). Surface
    // MUST match the HTTP chat canonical key so consent / policy /
    // audit lookups agree with the original turn's attribution.
    memory: createInProcessMemoryClient({ surface: 'http.chat.generate' }),
    toolExecutor: createInProcessToolExecutor({
      surface: 'http.chat.generate',
      evolveSessionRepository: container.evolveSessionRepository,
      permissionRepo: container.toolPermissionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: process.cwd(),
    }),
    operatorChatSessionRepository: container.operatorChatSessionRepository,
    conversationContextService: container.conversationContextService,
  };
}

async function runWorkerOnce(context: CliContext): Promise<boolean> {
  // Phase 4.3 (autopilot 2026-05-08): close issue #278 — `worker once`
  // mutates queue state. Operator passphrase required.
  const { requireOperatorAuth } = await import('../../auth/operator-gate.js');
  if (!(await requireOperatorAuth(undefined, process.env, context.args.operatorPassphrase))) {
    throw new Error('Operator authentication failed.');
  }
  const container = context.getContainer();
  const runner = new LocalWorkerRunner(
    {
      workPollingService: container.workPollingService,
      orchestration: container.orchestration,
      runtime: buildRuntime(context),
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
      operatorChatSessionRepository: container.operatorChatSessionRepository,
    },
    {
      workerId: process.env.MEMPHIS_LOCAL_WORKER_ID?.trim() || `cli-worker:${process.pid}`,
      waitMs: 1,
      capabilityScope: [...DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE],
      source: 'cli',
    },
  );

  const outcome = await runner.runOnce();
  print(
    {
      ok: true,
      mode: 'worker.once',
      outcome,
      snapshot: container.workPollingService.snapshot(),
      localWorker: getLocalWorkerRuntimeStatus(),
    },
    context.args.json,
  );
  return true;
}

async function runWorkerLoop(context: CliContext): Promise<boolean> {
  // Phase 4.3 (autopilot 2026-05-08): close issue #278 — `worker run`
  // continuously mutates queue state. Operator passphrase required.
  const { requireOperatorAuth } = await import('../../auth/operator-gate.js');
  if (!(await requireOperatorAuth(undefined, process.env, context.args.operatorPassphrase))) {
    throw new Error('Operator authentication failed.');
  }
  const container = context.getContainer();
  const snapshot = container.workPollingService.snapshot();
  if (!snapshot.tokenReady) {
    throw new Error('worker session tokens are not ready; set MEMPHIS_SESSION_TOKEN_SECRET first');
  }

  const runner = new LocalWorkerRunner(
    {
      workPollingService: container.workPollingService,
      orchestration: container.orchestration,
      runtime: buildRuntime(context),
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
      operatorChatSessionRepository: container.operatorChatSessionRepository,
    },
    {
      workerId: process.env.MEMPHIS_LOCAL_WORKER_ID?.trim() || `cli-worker:${process.pid}`,
      waitMs: Math.max(1, Math.min(context.args.durationMs ?? 5_000, 30_000)),
      capabilityScope: [...DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE],
      source: 'cli',
    },
  );

  runner.start();
  const durationMs = context.args.durationMs;
  const onSignal = () => void runner.stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (durationMs && durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      await runner.stop();
      print(
        {
          ok: true,
          mode: 'worker.run',
          durationMs,
          snapshot: container.workPollingService.snapshot(),
          localWorker: getLocalWorkerRuntimeStatus(),
        },
        context.args.json,
      );
      return true;
    }

    if (!context.args.json) {
      console.log('local worker running; press Ctrl+C to stop');
    }
    await new Promise<void>((resolve) => {
      const stop = async () => {
        await runner.stop();
        resolve();
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
    });
    return true;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function printStatus(context: CliContext): boolean {
  const snapshot = context.getContainer().workPollingService.snapshot();
  print(
    {
      ok: true,
      mode: 'worker.status',
      snapshot,
      localWorker: getLocalWorkerRuntimeStatus(),
    },
    context.args.json,
  );
  return true;
}

export const workerCommandHandler: CommandHandler = {
  name: 'worker',
  commands: ['worker'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'worker';
  },
  async handle(context: CliContext): Promise<boolean> {
    const subcommand = context.args.subcommand ?? 'status';
    if (subcommand === 'status') {
      return printStatus(context);
    }
    if (subcommand === 'once') {
      return runWorkerOnce(context);
    }
    if (subcommand === 'run') {
      return runWorkerLoop(context);
    }

    throw new Error('worker supports: status | once | run [--duration-ms <ms>] [--json]');
  },
};
