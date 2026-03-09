import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import {
  formatImportReport,
  guardWriteMode,
  runImportJsonFromFile,
  transactionalWriteBlocks,
} from './import-json.js';
import { createAppContainer } from '../../app/container.js';
import { listVaultEntries, saveVaultEntry } from '../storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt, vaultInit } from '../storage/rust-vault-adapter.js';
import {
  embedReset,
  embedSearch,
  embedSearchTuned,
  embedStore,
  getRustEmbedAdapterStatus,
} from '../storage/rust-embed-adapter.js';
import { runInteractiveTui } from './interactive-tui.js';
import { runTuiApp } from '../../tui/index.js';
import { checklistFromEnv, runWizardInteractive, writeProfileEnv, type WizardProfile } from './onboarding-wizard.js';

type CliArgs = {
  command?: string;
  subcommand?: string;
  json: boolean;
  tui: boolean;
  write: boolean;
  input?: string;
  provider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
  model?: string;
  file?: string;
  out?: string;
  confirmWrite: boolean;
  key?: string;
  value?: string;
  passphrase?: string;
  recoveryQuestion?: string;
  recoveryAnswer?: string;
  id?: string;
  query?: string;
  topK?: number;
  tuned?: boolean;
  strategy?: 'default' | 'latency-aware';
  interactive: boolean;
  profile?: WizardProfile;
  force: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(token, true);
      continue;
    }

    flags.set(token, next);
    i += 1;
  }

  const readFlag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };

  const hasFlag = (name: string): boolean => flags.get(name) === true;

  return {
    command: positionals[0],
    subcommand: positionals[1],
    json: hasFlag('--json'),
    tui: hasFlag('--tui'),
    write: hasFlag('--write'),
    input: readFlag('--input'),
    provider: readFlag('--provider') as CliArgs['provider'],
    model: readFlag('--model'),
    file: readFlag('--file'),
    out: readFlag('--out'),
    confirmWrite: hasFlag('--confirm-write'),
    key: readFlag('--key'),
    value: readFlag('--value'),
    passphrase: readFlag('--passphrase'),
    recoveryQuestion: readFlag('--recovery-question'),
    recoveryAnswer: readFlag('--recovery-answer'),
    id: readFlag('--id'),
    query: readFlag('--query'),
    topK: readFlag('--top-k') ? Number(readFlag('--top-k')) : undefined,
    tuned: hasFlag('--tuned'),
    strategy: readFlag('--strategy') as CliArgs['strategy'],
    interactive: hasFlag('--interactive'),
    profile: readFlag('--profile') as CliArgs['profile'],
    force: hasFlag('--force'),
  };
}

function print(data: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (typeof data === 'object' && data !== null) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      console.log(`${k}: ${String(v)}`);
    }
    return;
  }

  console.log(String(data));
}

function printChat(data: {
  id: string;
  providerUsed: string;
  modelUsed?: string;
  output: string;
  timingMs: number;
}): void {
  console.log(`id: ${data.id}`);
  console.log(`provider: ${data.providerUsed}`);
  if (data.modelUsed) console.log(`model: ${data.modelUsed}`);
  console.log(`timingMs: ${data.timingMs}`);
  console.log('---');
  console.log(data.output);
}

function printTuiAnswer(data: { providerUsed: string; output: string; trace?: { attempts: Array<{ provider: string; ok: boolean; latencyMs: number; viaFallback: boolean; errorCode?: string }> } }): void {
  const separator = '═'.repeat(48);
  console.log(`╔${separator}╗`);
  console.log(`║ memphis ask · provider=${data.providerUsed}${' '.repeat(Math.max(0, 16 - data.providerUsed.length))}║`);
  if (data.trace) {
    const attempts = data.trace.attempts
      .map((a) => `${a.provider}:${a.ok ? 'ok' : a.errorCode ?? 'err'}:${a.latencyMs}ms${a.viaFallback ? ':fb' : ''}`)
      .join(' | ');
    const safe = attempts.length > 46 ? `${attempts.slice(0, 45)}…` : attempts;
    console.log(`║ trace ${safe.padEnd(40, ' ')} ║`);
  }
  console.log(`╠${separator}╣`);
  for (const line of data.output.split('\n')) {
    const safe = line.length > 46 ? `${line.slice(0, 45)}…` : line;
    console.log(`║ ${safe.padEnd(46, ' ')} ║`);
  }
  console.log(`╚${separator}╝`);
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const {
    command,
    subcommand,
    json,
    tui,
    write,
    input,
    provider,
    model,
    file,
    out,
    confirmWrite,
    key,
    value,
    passphrase,
    recoveryQuestion,
    recoveryAnswer,
    id,
    query,
    topK,
    tuned,
    strategy,
    interactive,
    profile,
    force,
  } = parseArgs(argv);

  if (!command || command === 'help' || command === '--help') {
    print(
      {
        usage: 'memphis-v4 <command> [--json]',
        commands:
          'health | providers:health | chat|ask --input "..." [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | tui | doctor | onboarding wizard [--interactive] [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--write --out .env --force] | chain import_json --file <path> [--write --confirm-write --out <path>] | vault init|add|get|list | embed store|search [--tuned]|reset',
      },
      json,
    );
    return;
  }

  if (command === 'doctor') {
    const embed = getRustEmbedAdapterStatus(process.env);
    const checks = {
      node: process.version,
      npmAvailable: commandExists('npm'),
      cargoAvailable: commandExists('cargo'),
      envFilePresent: existsSync(resolve('.env')),
      rustChainEnabled: process.env.RUST_CHAIN_ENABLED ?? 'false',
      rustBridgePath: embed.rustBridgePath,
      rustBridgePathExists: existsSync(resolve(embed.rustBridgePath)),
      embedApiAvailable: embed.embedApiAvailable,
      embedTunedSearchAvailable: embed.tunedSearchAvailable,
      embedMode: process.env.RUST_EMBED_MODE ?? 'local',
      vaultPepperConfigured: (process.env.MEMPHIS_VAULT_PEPPER ?? '').length >= 12,
    };

    print(
      {
        ok: checks.npmAvailable && checks.cargoAvailable,
        checks,
      },
      json,
    );
    return;
  }

  if (command === 'embed') {
    if (subcommand === 'reset') {
      print({ ok: true, data: embedReset(process.env) }, json);
      return;
    }

    if (subcommand === 'store') {
      if (!id || value === undefined) throw new Error('embed store requires --id and --value');
      print({ ok: true, data: embedStore(id, value, process.env) }, json);
      return;
    }

    if (subcommand === 'search') {
      if (!query) throw new Error('embed search requires --query');
      const data = tuned ? embedSearchTuned(query, topK ?? 5, process.env) : embedSearch(query, topK ?? 5, process.env);
      print({ ok: true, data }, json);
      return;
    }

    throw new Error(`Unknown embed subcommand: ${String(subcommand)}`);
  }

  if (command === 'chain' && subcommand === 'import_json') {
    if (!file) throw new Error('Missing required --file for chain import_json');

    const report = runImportJsonFromFile(file);
    const outputPath = resolve(out ?? './data/imported-chain.json');
    guardWriteMode({
      writeEnabled: write,
      confirmationProvided: confirmWrite,
      sourcePath: file,
      destinationPath: outputPath,
    });

    const writeResult =
      write === true
        ? {
            mode: 'write' as const,
            targetPath: outputPath,
            writtenBlocks: report.blocks.length,
            ...transactionalWriteBlocks(outputPath, report.blocks),
          }
        : { mode: 'dry-run' as const, targetPath: outputPath };

    if (json) {
      print({ ...report, write: writeResult }, true);
      return;
    }
    console.log(formatImportReport(report, writeResult));
    return;
  }

  if (command === 'vault') {
    if (subcommand === 'init') {
      if (!passphrase || !recoveryQuestion || !recoveryAnswer) {
        throw new Error('vault init requires --passphrase --recovery-question --recovery-answer');
      }
      const outVault = vaultInit(
        { passphrase, recovery_question: recoveryQuestion, recovery_answer: recoveryAnswer },
        process.env,
      );
      print({ ok: true, vault: outVault }, json);
      return;
    }

    if (subcommand === 'add') {
      if (!key || value === undefined) throw new Error('vault add requires --key and --value');
      const encrypted = vaultEncrypt(key, value, process.env);
      const stored = saveVaultEntry(encrypted, process.env);
      print({ ok: true, entry: stored }, json);
      return;
    }

    if (subcommand === 'get') {
      if (!key) throw new Error('vault get requires --key');
      const entries = listVaultEntries(process.env, key);
      const latest = entries.at(-1);
      if (!latest) throw new Error(`vault key not found: ${key}`);
      const plaintext = vaultDecrypt(latest, process.env);
      print({ ok: true, key, value: plaintext }, json);
      return;
    }

    if (subcommand === 'list') {
      print({ ok: true, entries: listVaultEntries(process.env, key) }, json);
      return;
    }

    throw new Error(`Unknown vault subcommand: ${String(subcommand)}`);
  }

  if (command === 'onboarding' && subcommand === 'wizard') {
    if (interactive) {
      const outWizard = await runWizardInteractive(profile ?? 'dev-local');
      print({ ok: true, interactive: true, ...outWizard }, json);
      return;
    }

    if (write) {
      if (!profile) {
        throw new Error('onboarding wizard --write requires --profile');
      }
      const written = writeProfileEnv(profile, out ?? '.env', force);
      print({ ok: true, write: written }, json);
      return;
    }

    const embed = getRustEmbedAdapterStatus(process.env);
    const checklist = checklistFromEnv(process.env).map((item) => {
      if (item.step !== 'rust-bridge') return item;
      return { ...item, done: embed.rustEnabled && embed.bridgeLoaded };
    });

    const doneCount = checklist.filter((x) => x.done).length;
    print(
      {
        ok: doneCount === checklist.length,
        progress: `${doneCount}/${checklist.length}`,
        checklist,
        profiles: ['dev-local', 'prod-shared', 'prod-decentralized', 'ollama-local'],
      },
      json,
    );
    return;
  }

  const config = loadConfig();
  const container = createAppContainer(config);

  if (command === 'health') {
    const payload = {
      status: 'ok',
      service: 'memphis-v4',
      version: '0.1.0',
      nodeEnv: config.NODE_ENV,
      defaultProvider: config.DEFAULT_PROVIDER,
      timestamp: new Date().toISOString(),
    };
    print(payload, json);
    return;
  }

  if (command === 'providers:health') {
    const providers = await container.orchestration.providersHealth();
    const payload = {
      defaultProvider: config.DEFAULT_PROVIDER,
      providers,
    };
    print(payload, json);
    return;
  }

  if (command === 'tui') {
    await runTuiApp({
      orchestration: container.orchestration,
      provider: provider ?? 'auto',
      model,
      strategy,
    });
    return;
  }

  if (command === 'chat' || command === 'ask') {
    if (interactive) {
      await runInteractiveTui({
        orchestration: container.orchestration,
        provider: provider ?? 'auto',
        model,
        strategy,
      });
      return;
    }

    if (!input || input.trim().length === 0) {
      throw new Error('Missing required --input for chat/ask command');
    }

    const result = await container.orchestration.generate({
      input,
      provider: provider ?? 'auto',
      model,
      strategy,
    });

    if (json) {
      print(result, true);
      return;
    }

    if (tui) {
      printTuiAnswer(result);
      return;
    }

    printChat(result);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(4);
});
