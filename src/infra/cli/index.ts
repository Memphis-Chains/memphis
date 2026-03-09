import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/env.js';
import { formatImportReport, runImportJsonPayload } from './import-json.js';
import { createAppContainer } from '../../app/container.js';
import { listVaultEntries, saveVaultEntry } from '../storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt, vaultInit } from '../storage/rust-vault-adapter.js';
import { embedReset, embedSearch, embedStore, getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';

type CliArgs = {
  command?: string;
  subcommand?: string;
  json: boolean;
  tui: boolean;
  input?: string;
  provider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
  model?: string;
  file?: string;
  key?: string;
  value?: string;
  passphrase?: string;
  recoveryQuestion?: string;
  recoveryAnswer?: string;
  id?: string;
  query?: string;
  topK?: number;
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
    input: readFlag('--input'),
    provider: readFlag('--provider') as CliArgs['provider'],
    model: readFlag('--model'),
    file: readFlag('--file'),
    key: readFlag('--key'),
    value: readFlag('--value'),
    passphrase: readFlag('--passphrase'),
    recoveryQuestion: readFlag('--recovery-question'),
    recoveryAnswer: readFlag('--recovery-answer'),
    id: readFlag('--id'),
    query: readFlag('--query'),
    topK: readFlag('--top-k') ? Number(readFlag('--top-k')) : undefined,
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

function printTuiAnswer(data: { providerUsed: string; output: string }): void {
  const separator = '═'.repeat(48);
  console.log(`╔${separator}╗`);
  console.log(`║ memphis ask · provider=${data.providerUsed}${' '.repeat(Math.max(0, 16 - data.providerUsed.length))}║`);
  console.log(`╠${separator}╣`);
  for (const line of data.output.split('\n')) {
    const safe = line.length > 46 ? `${line.slice(0, 45)}…` : line;
    console.log(`║ ${safe.padEnd(46, ' ')} ║`);
  }
  console.log(`╚${separator}╝`);
}

function runImportJson(file: string) {
  const raw = readFileSync(file, 'utf8');
  const payload = JSON.parse(raw) as unknown;
  return runImportJsonPayload(payload);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const {
    command,
    subcommand,
    json,
    tui,
    input,
    provider,
    model,
    file,
    key,
    value,
    passphrase,
    recoveryQuestion,
    recoveryAnswer,
    id,
    query,
    topK,
  } = parseArgs(argv);

  if (!command || command === 'help' || command === '--help') {
    print(
      {
        usage: 'memphis-v4 <command> [--json]',
        commands:
          'health | providers:health | chat|ask --input "..." [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--tui] | doctor | chain import_json --file <path> | vault init|add|get|list | embed store|search|reset',
      },
      json,
    );
    return;
  }

  if (command === 'doctor') {
    const embed = getRustEmbedAdapterStatus(process.env);
    print(
      {
        ok: true,
        checks: {
          node: process.version,
          rustChainEnabled: process.env.RUST_CHAIN_ENABLED ?? 'false',
          rustBridgePath: embed.rustBridgePath,
          embedApiAvailable: embed.embedApiAvailable,
          vaultPepperConfigured: (process.env.MEMPHIS_VAULT_PEPPER ?? '').length >= 12,
        },
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
      print({ ok: true, data: embedSearch(query, topK ?? 5, process.env) }, json);
      return;
    }

    throw new Error(`Unknown embed subcommand: ${String(subcommand)}`);
  }

  if (command === 'chain' && subcommand === 'import_json') {
    if (!file) throw new Error('Missing required --file for chain import_json');
    const report = runImportJson(file);
    if (json) {
      print(report, true);
      return;
    }
    console.log(formatImportReport(report));
    return;
  }

  if (command === 'vault') {
    if (subcommand === 'init') {
      if (!passphrase || !recoveryQuestion || !recoveryAnswer) {
        throw new Error('vault init requires --passphrase --recovery-question --recovery-answer');
      }
      const out = vaultInit(
        { passphrase, recovery_question: recoveryQuestion, recovery_answer: recoveryAnswer },
        process.env,
      );
      print({ ok: true, vault: out }, json);
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

  if (command === 'chat' || command === 'ask') {
    if (!input || input.trim().length === 0) {
      throw new Error('Missing required --input for chat/ask command');
    }

    const result = await container.orchestration.generate({
      input,
      provider: provider ?? 'auto',
      model,
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
