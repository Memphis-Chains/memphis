import chalk from 'chalk';
import { rebuildChainIndexes } from '../../../core/chain-index-rebuild.js';
import { DynamicRouter } from '../../../providers/dynamic-router.js';
import { handleBackupCommand } from '../commands/backup.js';
import { handleConfigureCommand } from '../commands/configure.js';
import { serveCommand } from '../commands/serve.js';
import { handleSetupCommand } from '../commands/setup.js';
import type { CliContext } from '../context.js';
import { listModelsWithCapabilities, listConfiguredProviders } from '../provider-capabilities.js';
import type { CompletionShell } from '../types.js';
import { runDoctorChecksV2, printDoctorHumanV2 } from '../utils/doctor-v2.js';
import {
  generateCompletionScript,
  getCreativeLogo,
  print,
  printModelsHuman,
  printProvidersHuman,
  renderRoadmapProgress,
  runCelebration,
} from '../utils/render.js';
import type { CommandHandler } from './command-handler.js';

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
  'completion',
  'setup',
  'init',
  'configure',
  'backup',
  'health',
  'chain',
] as const;

function printHelp(json: boolean): void {
  print(
    {
      usage: 'memphis <command> [--json]',
      commands:
        'setup|init [--out .env --force] | configure [--non-interactive] [--dry-run] | backup [--list|--restore <id> --yes|--clean [--keep <n>]] | health | reflect [--save] | learn [--reset] | insights [--daily|--weekly|--topic <name>] | connections scan|find --query "A,B" | suggest | categorize <text> [--save] | providers:health | providers list | models list | chat|ask|ask-session|route|decide --input "..."|infer [--days <n>] [--repo-path <path>]|predict [--repo-path <path>]|git-stats [--days <n>] [--repo-path <path>]|agents list|agents discover|agents show <did>|relationships show <did>|trust <did>|mcp [serve|serve-once|serve-status|serve-stop] [--input "..."] [--session <name>] [--schema] [--transport stdio|http] [--port <n>] [--duration-ms <n>] [--to proposed|accepted|implemented|verified|superseded|rejected] [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | ascii [--size small|medium|large] | progress | celebrate <milestone> | tui | doctor [--fix --force --deep] | onboarding wizard|bootstrap [--interactive] [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--write --out .env --force] [--dry-run|--apply --yes] | chain import_json --file <path> [--write --confirm-write --out <path>] | chain rebuild [--out <path>] | chain verify [--chain <name>] | sync status [--chain <name>] | sync push --chain <name> | sync pull --agent <did> [--chain <name>] | trade offer --recipient <did> [--blocks 1-100] [--file <path>] | trade accept --offer-id <id> --file <offer.json> | vault init|add|get|list | embed store|search [--tuned]|reset | completion <bash|zsh|fish>',
    },
    json,
  );
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
  });

  if (context.args.json) {
    print(report, true);
  } else {
    printDoctorHumanV2(report);
  }
  process.exitCode = report.ok ? 0 : 1;
  return true;
}

async function handleProviders(context: CliContext): Promise<boolean> {
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
  if (context.args.subcommand !== 'list') {
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

export const systemCommandHandler: CommandHandler = {
  name: 'system',
  commands: SYSTEM_COMMANDS,
  canHandle(context: CliContext): boolean {
    return SYSTEM_COMMANDS.includes(context.args.command);
  },
  async handle(context: CliContext): Promise<boolean> {
    const { command, json, out, size, subcommand } = context.args;

    if (!command || command === 'help' || command === '--help') {
      printHelp(json);
      return true;
    }

    if (await handleConfigureCommand(context)) {
      return true;
    }

    if (await handleSetupCommand(context)) {
      return true;
    }

    if (await handleBackupCommand(context)) {
      return true;
    }

    if (command === 'completion') {
      return handleCompletion(context);
    }

    if (command === 'doctor') {
      return handleDoctor(context);
    }

    if (command === 'providers') {
      return handleProviders(context);
    }

    if (command === 'models') {
      return handleModels(context);
    }

    if (command === 'route') {
      return handleRoute(context);
    }

    if (command === 'ascii') {
      const payload = getCreativeLogo(size);
      const resolvedSize =
        size && ['small', 'medium', 'large'].includes(size) ? size : 'medium';
      if (json) {
        print({ ok: true, mode: 'ascii', size: resolvedSize, output: payload }, true);
      } else {
        console.log(chalk.cyan(payload));
      }
      return true;
    }

    if (command === 'progress') {
      const output = `${chalk.bold.cyan('△⬡◈ MEMPHIS V5 ROADMAP')}\n${renderRoadmapProgress()}`;
      if (json) {
        print({ ok: true, mode: 'progress', output }, true);
      } else {
        console.log(output);
      }
      return true;
    }

    if (command === 'celebrate') {
      await runCelebration(subcommand ?? 'V5 Milestone');
      return true;
    }

    if (command === 'health') {
      const config = context.getConfig();
      print(
        {
          status: 'ok',
          service: 'memphis-v5',
          version: '0.1.0',
          nodeEnv: config.NODE_ENV,
          defaultProvider: config.DEFAULT_PROVIDER,
          timestamp: new Date().toISOString(),
        },
        json,
      );
      return true;
    }

    if (command === 'serve') {
      await serveCommand();
      return true;
    }

    if (command === 'chain' && subcommand === 'rebuild') {
      print(rebuildChainIndexes({ indexFile: out }), json);
      return true;
    }

    return false;
  },
};
