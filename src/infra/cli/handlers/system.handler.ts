import chalk from 'chalk';

import type { CommandHandler } from './command-handler.js';
import { getAppVersion } from '../../../config/paths.js';
import { REQUESTED_PROVIDER_NAMES } from '../../../core/types.js';
import { DynamicRouter } from '../../../providers/dynamic-router.js';
import { buildHealthPayload } from '../../http/health.js';
import { buildOperatorGuide, renderOperatorGuideText } from '../../operator-guide.js';
import { runAllHealthChecks } from '../../ops/cron-health.js';
import { handleZombieCommand } from '../../ops/zombie-cleanup.js';
import { repairRuntimeState } from '../../runtime/runtime-repair.js';
import { handleBackupCommand } from '../commands/backup.js';
import { handleDeployCommand } from '../commands/deploy.js';
import { handleReadinessCommand } from '../commands/readiness.js';
import { handleSelfRestartCommand } from '../commands/restart.js';
import { handleSelfUpdateCommand } from '../commands/self-update.js';
import { serveCommand } from '../commands/serve.js';
import { handleServiceCommand } from '../commands/service.js';
import { handleSetupCommand } from '../commands/setup.js';
import { handleWorkspaceCommand } from '../commands/workspace.js';
import type { CliContext } from '../context.js';
import { listConfiguredProviders, listModelsWithCapabilities } from '../provider-capabilities.js';
import type { CompletionShell } from '../types.js';
import { printDoctorHumanV2, runDoctorChecksV2, type DoctorContainer } from '../utils/doctor-v2.js';
import {
  generateCompletionScript,
  getCreativeLogo,
  print,
  printModelsHuman,
  printProvidersHuman,
  renderRoadmapProgress,
  runCelebration,
} from '../utils/render.js';

const SYSTEM_COMMANDS = [
  undefined,
  'help',
  '--help',
  'serve',
  'doctor',
  'providers',
  'models',
  'route',
  'ascii',
  'progress',
  'celebrate',
  'guide',
  'completion',
  'setup',
  'init',
  'deploy',
  'backup',
  'self-update',
  'restart',
  'health',
  'workspace',
  'context',
  'service',
  'reset',
  'repair',
  'kill-zombies',
  'readiness',
] as const;

function printHelp(json: boolean): void {
  const providerOptions = REQUESTED_PROVIDER_NAMES.join('|');
  const payload = {
    usage: 'memphis <command> [--json]',
    commands: `init [status] [--state minimal-baseline|guided-conversation] [--non-interactive] [--operator-passphrase <secret>] [--passphrase <secret>] [--recovery-question <q>] [--recovery-answer <a>] | setup matrix [--server-name <name>] [--admin-user <user>] [--admin-pass <pass>] | setup telegram --bot-token <token> [--allowed-user-ids <csv>] | readiness [--json] | deploy run|health|rollback [--profile local-service|build-only|custom] [--build-command <cmd>] [--deploy-command <cmd>] [--health-url <url>] [--test-suite ts|rust|lint|typecheck|all] [--latest <n>] [--deep] [--dry-run] | backup [create|list|verify <file>|restore <file>|clean] [--yes] [--pepper-restore <old-pepper>] [--keep <n>] [--tag <name>] | self-update [check] | kill-zombies [--dry-run] [--port <n>] | service status|install|logs|restart|uninstall [--latest <n>] | worker status|once|run [--duration-ms <n>] | reset --runtime --yes | repair runtime [--force] | health [--cron] | reflect [--save] | learn [--reset] | insights [--daily|--weekly|--topic <name>] | connections scan|find --query "A,B" | suggest | categorize <text> [--save] | knowledge status|sources|query --topic <text> [--source <id>] [--limit <n>] | providers health|list | models list | chat|ask|ask-session|route|decide --input "..."|history|transition|infer [--days <n>] [--repo-path <path>] [chain-first default]|predict [--repo-path <path>] [chain-first default]|git-stats [--days <n>] [--repo-path <path>] [legacy debug only; git is not runtime memory]|agents list|agents discover|agents show <did>|relationships show <did>|trust list|add <tool>|remove <tool>|mode set <full|quiet|balanced|paranoid>|mcp [serve|serve-once|serve-status|serve-stop] [--input "..."] [--session <name>] [--schema] [--transport stdio|http] [--port <n>] [--duration-ms <n>] [--to proposed|accepted|implemented|verified|superseded|rejected] [--provider ${providerOptions}] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | ascii [--size small|medium|large] | progress | celebrate <milestone> | guide | tui [--check-only --json] [--run-command "/config tools list" --json] | doctor [--fix --force --deep] | config tools <list|allow|deny|set|check|reset|pending|approve-call|deny-call> | config surfaces <list|check|set|reset> | chain import_json --file <path> [--write --confirm-write --out <path>] | chain export --chain <name> [--out <path>] | chain rebuild [--out <path>] | chain verify [--chain <name>] | search --query <phrase> [--top-k <n>] [--chain <name>] | search rebuild [--chain <name>] | sync status [--chain <name>]|push --chain <name>|pull --agent <did>|network | trade offer --recipient <did> [--blocks 1-100] [--file <path>] | trade accept --offer-id <id> --file <offer.json> | vault init|add|get|list|reset|pepper-rotate|master-key-rotate|entry-delete|recovery-unlock | audit search [--since <iso>] [--until <iso>] [--action <pattern>] [--status <pattern>] [--limit <n>] | embed store|search [--tuned]|reindex [--chain <name>]|reset | evolve status|rollback|log | apps list|show|plan|run|validate|import|install|start|stop|restart|status|doctor|dashboard | skills list|show|install|create|validate|import | operator status|set-passphrase|recover | telegram send|status | secret add|get|list | explain [--chain <name>] [--case-type <type>] [--entity <name>] | debug trace|profile|memory|monitor | completion <bash|zsh|fish>`,
    guide: buildOperatorGuide(process.env),
  };

  if (json) {
    print(payload, true);
    return;
  }

  print({ usage: payload.usage, commands: payload.commands }, false);
  console.log('');
  console.log(renderOperatorGuideText(process.env));
}

async function handleCompletion(context: CliContext): Promise<boolean> {
  const shell = context.args.subcommand as CompletionShell | undefined;
  if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
    throw new Error('completion requires shell argument: bash | zsh | fish');
  }

  const script = generateCompletionScript(shell);
  process.stdout.write(script);
  if (!script.endsWith('\n')) {
    process.stdout.write('\n');
  }
  return true;
}

async function handleDoctor(context: CliContext): Promise<boolean> {
  const report = await runDoctorChecksV2({
    fix: context.args.fix,
    force: context.args.force,
    deep: context.args.deep,
    getContainer: () => context.getContainer() as DoctorContainer,
  });

  if (context.args.json) {
    print(report, true);
  } else {
    printDoctorHumanV2(report);
  }
  process.exitCode = report.ok ? 0 : 1;
  return true;
}

async function handleRepair(context: CliContext): Promise<boolean> {
  if (context.args.subcommand !== 'runtime') {
    throw new Error('repair currently supports only: memphis repair runtime [--force] [--json]');
  }

  const result = await repairRuntimeState({ rawEnv: process.env, force: context.args.force });
  if (context.args.json) {
    print(result, true);
  } else {
    console.log(`runtime repair: ${result.status}`);
    console.log(`recommended action: ${result.recommendedAction}`);
    console.log(`applied: ${result.applied.length}`);
    for (const item of result.applied) console.log(`  - ${item}`);
    if (result.skipped.length > 0) {
      console.log(`skipped: ${result.skipped.length}`);
      for (const item of result.skipped) console.log(`  - ${item}`);
    }
    if (result.warnings.length > 0) {
      console.log(`warnings: ${result.warnings.length}`);
      for (const item of result.warnings) console.log(`  - ${item}`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
  return true;
}

async function handleProviders(context: CliContext): Promise<boolean> {
  if (context.args.subcommand === 'health') {
    const config = context.getConfig();
    const providers = await context.getContainer().orchestration.providersHealth();
    print({ defaultProvider: config.DEFAULT_PROVIDER, providers }, context.args.json);
    return true;
  }

  if (context.args.subcommand !== 'list') {
    return false;
  }

  const providers = listConfiguredProviders(process.env);
  if (context.args.json) {
    print({ providers }, true);
  } else {
    printProvidersHuman(providers);
  }
  return true;
}

async function handleModels(context: CliContext): Promise<boolean> {
  // Default `memphis models` to `memphis models list` — the only supported
  // subcommand today. Previously the handler returned false when no
  // subcommand was supplied, which fell through to the dispatcher's
  // "Unknown command: models" error (observed 2026-04-20 on operator WSL),
  // even though `models` is in the command registry and `/help` advertises
  // it. Explicit `memphis models list` still works identically.
  const subcommand = context.args.subcommand ?? 'list';
  if (subcommand !== 'list') {
    return false;
  }

  const models = await listModelsWithCapabilities(process.env);
  if (context.args.json) {
    print({ models }, true);
  } else {
    printModelsHuman(models);
  }
  return true;
}

function handleRoute(context: CliContext): boolean {
  const router = new DynamicRouter();
  const result = router.route({
    taskType: context.args.taskType ?? 'chat',
    priority: context.args.priority ?? 'quality',
    requirements: {
      minContextWindow: context.args.minContext ?? 4096,
      needsVision: context.args.vision,
      needsFunctionCalling: context.args.functions,
    },
  });

  if (context.args.json) {
    print({ decision: result, stats: router.getRoutingStats() }, true);
    return true;
  }

  console.log(chalk.cyan('Routing Decision:'));
  console.log(`  Provider: ${chalk.green(result.provider)}`);
  console.log(`  Model: ${chalk.green(result.model)}`);
  console.log(`  Reason: ${chalk.gray(result.reason)}`);
  console.log('');
  console.log(chalk.cyan('Routing Stats:'));
  console.log(JSON.stringify(router.getRoutingStats(), null, 2));
  return true;
}

function handleAscii(context: CliContext): boolean {
  const { json, size } = context.args;
  const payload = getCreativeLogo(size);
  const resolvedSize = size && ['small', 'medium', 'large'].includes(size) ? size : 'medium';
  if (json) {
    print({ ok: true, mode: 'ascii', size: resolvedSize, output: payload }, true);
  } else {
    console.log(chalk.cyan(payload));
  }
  return true;
}

function handleProgress(context: CliContext): boolean {
  const output = `${chalk.bold.cyan('△⬡◈ MEMPHIS ROADMAP')}\n${renderRoadmapProgress()}`;
  if (context.args.json) {
    print({ ok: true, mode: 'progress', output }, true);
  } else {
    console.log(output);
  }
  return true;
}

async function handleHealth(context: CliContext): Promise<boolean> {
  if (context.args.cron) {
    const results = await runAllHealthChecks();
    const allOk =
      results.ollamaHealth.ok &&
      results.chainIntegrity.ok &&
      results.vaultState.ok &&
      results.diskSpace.ok &&
      results.caseIndex.ok;
    print(
      {
        status: allOk ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks: results,
      },
      context.args.json,
    );
    return true;
  }

  const config = context.getConfig();
  const runtimeHealth = await buildHealthPayload(config, process.env, {
    workPolling: context.getContainer().workPollingService.snapshot(),
  });
  print(
    {
      status: 'ok',
      service: 'memphis',
      version: getAppVersion(),
      nodeEnv: config.NODE_ENV,
      defaultProvider: config.DEFAULT_PROVIDER,
      timestamp: new Date().toISOString(),
      runtimeStatus: runtimeHealth.status,
      repairable: runtimeHealth.repairable,
      recommendedAction: runtimeHealth.recommendedAction,
      checks: runtimeHealth.checks,
      runtime: runtimeHealth.runtime,
      surfacePolicies: runtimeHealth.surfacePolicies,
      workPolling: runtimeHealth.workPolling ?? null,
      localWorker: runtimeHealth.localWorker ?? null,
      scheduler: runtimeHealth.scheduler ?? null,
      uptimeSeconds: runtimeHealth.uptime_seconds,
    },
    context.args.json,
  );
  return true;
}

function handleGuide(context: CliContext): boolean {
  if (context.args.json) {
    print(buildOperatorGuide(process.env), true);
  } else {
    console.log(renderOperatorGuideText(process.env));
  }
  return true;
}

async function handleSystemBuiltins(context: CliContext): Promise<boolean> {
  const { command, subcommand } = context.args;

  if (command === 'celebrate') {
    await runCelebration(subcommand ?? 'V5 Milestone');
    return true;
  }

  if (command === 'serve') {
    await serveCommand(context.args.telegram);
    return true;
  }

  const handlers: Partial<
    Record<Exclude<(typeof SYSTEM_COMMANDS)[number], undefined>, () => Promise<boolean> | boolean>
  > = {
    completion: () => handleCompletion(context),
    doctor: () => handleDoctor(context),
    providers: () => handleProviders(context),
    models: () => handleModels(context),
    route: () => handleRoute(context),
    ascii: () => handleAscii(context),
    progress: () => handleProgress(context),
    health: () => handleHealth(context),
    repair: () => handleRepair(context),
    guide: () => handleGuide(context),
    'kill-zombies': () => handleZombieCommand(context),
  };

  const handler =
    command && command in handlers ? handlers[command as keyof typeof handlers] : undefined;
  return handler ? await handler() : false;
}

export const systemCommandHandler: CommandHandler = {
  name: 'system',
  commands: SYSTEM_COMMANDS,
  canHandle(context: CliContext): boolean {
    return SYSTEM_COMMANDS.includes(context.args.command as (typeof SYSTEM_COMMANDS)[number]);
  },
  async handle(context: CliContext): Promise<boolean> {
    const { command, json } = context.args;

    if (!command || command === 'help' || command === '--help') {
      printHelp(json);
      return true;
    }

    if (await handleSetupCommand(context)) {
      return true;
    }

    if (await handleReadinessCommand(context)) {
      return true;
    }

    if (await handleDeployCommand(context)) {
      return true;
    }

    if (await handleBackupCommand(context)) {
      return true;
    }

    if (await handleSelfUpdateCommand(context)) {
      return true;
    }

    if (await handleSelfRestartCommand(context)) {
      return true;
    }

    if (await handleWorkspaceCommand(context)) {
      return true;
    }

    if (await handleServiceCommand(context)) {
      return true;
    }

    return handleSystemBuiltins(context);
  },
};
