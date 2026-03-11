import chalk from 'chalk';
import { rebuildChainIndexes } from '../../../core/chain-index-rebuild.js';
import { listModelsWithCapabilities, listConfiguredProviders } from '../provider-capabilities.js';
import { verifyChainIntegrity } from '../../storage/chain-adapter.js';
import { serveCommand } from './serve.js';
import { runDoctorChecksV2, printDoctorHumanV2 } from '../utils/doctor-v2.js';
import { generateCompletionScript, getCreativeLogo, print, printModelsHuman, printProvidersHuman, renderRoadmapProgress, runCelebration } from '../utils/render.js';
import type { CliContext } from '../context.js';
import type { CompletionShell } from '../types.js';
import { DynamicRouter } from '../../../providers/dynamic-router.js';
import { handleSetupCommand } from './setup.js';
import { handleConfigureCommand } from './configure.js';
import { handleBackupCommand } from './backup.js';

export async function handleSystemCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const { command, subcommand, json, out, taskType, priority, minContext, vision, functions, size, fix, force, deep, chain } = args;

  if (!command || command === 'help' || command === '--help') {
    print(
      {
        usage: 'memphis <command> [--json]',
        commands:
          'setup|init [--out .env --force] | configure [--non-interactive] [--dry-run] | backup [--list|--restore <id> --yes|--clean [--keep <n>]] | health | reflect [--save] | learn [--reset] | insights [--daily|--weekly|--topic <name>] | connections scan|find --query "A,B" | suggest | categorize <text> [--save] | providers:health | providers list | models list | chat|ask|ask-session|route|decide --input "..."|infer [--days <n>] [--repo-path <path>]|predict [--repo-path <path>]|git-stats [--days <n>] [--repo-path <path>]|agents list|agents discover|agents show <did>|relationships show <did>|trust <did>|mcp [serve|serve-once|serve-status|serve-stop] [--input "..."] [--session <name>] [--schema] [--transport stdio|http] [--port <n>] [--duration-ms <n>] [--to proposed|accepted|implemented|verified|superseded|rejected] [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | ascii [--size small|medium|large] | progress | celebrate <milestone> | tui | doctor [--fix --force --deep] | onboarding wizard|bootstrap [--interactive] [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--write --out .env --force] [--dry-run|--apply --yes] | chain import_json --file <path> [--write --confirm-write --out <path>] | chain rebuild [--out <path>] | chain verify [--chain <name>] | sync status [--chain <name>] | sync push --chain <name> | sync pull --agent <did> [--chain <name>] | trade offer --recipient <did> [--blocks 1-100] [--file <path>] | trade accept --offer-id <id> --file <offer.json> | vault init|add|get|list | embed store|search [--tuned]|reset | completion <bash|zsh|fish>',
      },
      json,
    );
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
    const shell = subcommand as CompletionShell | undefined;
    if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
      throw new Error('completion requires shell argument: bash | zsh | fish');
    }
    const script = generateCompletionScript(shell);
    process.stdout.write(script);
    if (!script.endsWith('\n')) process.stdout.write('\n');
    return true;
  }

  if (command === 'doctor') {
    const report = await runDoctorChecksV2({ fix, force, deep });
    if (json) print(report, true);
    else printDoctorHumanV2(report);
    process.exitCode = report.ok ? 0 : 1;
    return true;
  }

  if (command === 'chain' && subcommand === 'rebuild') {
    print(rebuildChainIndexes({ indexFile: out }), json);
    return true;
  }

  if (command === 'chain' && subcommand === 'verify') {
    try {
      const result = await verifyChainIntegrity(chain);
      print(result, json);
      return true;
    } catch (error) {
      throw new Error(`chain verification failed: ${error instanceof Error ? error.message : 'unknown error'}`, {
        cause: error,
      });
    }
  }

  if (command === 'providers' && subcommand === 'list') {
    const providers = listConfiguredProviders(process.env);
    if (json) print({ providers }, true);
    else printProvidersHuman(providers);
    return true;
  }

  if (command === 'models' && subcommand === 'list') {
    const models = await listModelsWithCapabilities(process.env);
    if (json) print({ models }, true);
    else printModelsHuman(models);
    return true;
  }

  if (command === 'route') {
    const router = new DynamicRouter();
    const result = router.route({
      taskType: taskType ?? 'chat',
      priority: priority ?? 'quality',
      requirements: {
        minContextWindow: minContext ?? 4096,
        needsVision: vision,
        needsFunctionCalling: functions,
      },
    });

    if (json) {
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

  if (command === 'ascii') {
    const payload = getCreativeLogo(size);
    if (json) print({ ok: true, mode: 'ascii', size: size && ['small', 'medium', 'large'].includes(size) ? size : 'medium', output: payload }, true);
    else console.log(chalk.cyan(payload));
    return true;
  }

  if (command === 'progress') {
    const output = `${chalk.bold.cyan('△⬡◈ MEMPHIS V5 ROADMAP')}\n${renderRoadmapProgress()}`;
    if (json) print({ ok: true, mode: 'progress', output }, true);
    else console.log(output);
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

  return false;
}
