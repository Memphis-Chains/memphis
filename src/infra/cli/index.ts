import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/env.js';
import { createAppContainer } from '../../app/container.js';
import { listVaultEntries, saveVaultEntry } from '../storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt, vaultInit } from '../storage/rust-vault-adapter.js';

type CliArgs = {
  command?: string;
  subcommand?: string;
  json: boolean;
  input?: string;
  provider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
  model?: string;
  file?: string;
  key?: string;
  value?: string;
  passphrase?: string;
  recoveryQuestion?: string;
  recoveryAnswer?: string;
};

type ChainBlock = {
  index: number;
  prev_hash: string;
  hash: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith('--')) {
      i += 1;
      continue;
    }
    positionals.push(token);
  }

  const readFlag = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const provider = readFlag('--provider') as CliArgs['provider'];

  return {
    command: positionals[0],
    subcommand: positionals[1],
    json,
    input: readFlag('--input'),
    provider,
    model: readFlag('--model'),
    file: readFlag('--file'),
    key: readFlag('--key'),
    value: readFlag('--value'),
    passphrase: readFlag('--passphrase'),
    recoveryQuestion: readFlag('--recovery-question'),
    recoveryAnswer: readFlag('--recovery-answer'),
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

function parseChainFile(path: string): ChainBlock[] {
  const raw = readFileSync(path, 'utf8');
  const payload = JSON.parse(raw) as ChainBlock[] | { blocks: ChainBlock[] };
  const blocks = Array.isArray(payload) ? payload : payload.blocks;
  if (!Array.isArray(blocks)) {
    throw new Error('import_json expects JSON array or {"blocks": [...]}');
  }
  return blocks;
}

function validateChainBlocks(blocks: ChainBlock[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.index !== i) {
      errors.push(`block[${i}] invalid index=${b.index}, expected=${i}`);
    }

    if (i === 0) {
      if (b.prev_hash !== '0'.repeat(64)) {
        errors.push('genesis prev_hash must be 64 zeros');
      }
    } else {
      const prev = blocks[i - 1];
      if (b.prev_hash !== prev.hash) {
        errors.push(`block[${i}] prev_hash mismatch`);
      }
    }
  }
  return errors;
}

function runImportJson(file: string): { imported: number; valid: boolean; errors: string[] } {
  const blocks = parseChainFile(file);
  const errors = validateChainBlocks(blocks);
  return { imported: blocks.length, valid: errors.length === 0, errors };
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const {
    command,
    subcommand,
    json,
    input,
    provider,
    model,
    file,
    key,
    value,
    passphrase,
    recoveryQuestion,
    recoveryAnswer,
  } = parseArgs(argv);

  if (!command || command === 'help' || command === '--help') {
    print(
      {
        usage: 'memphis-v4 <command> [--json]',
        commands:
          'health | providers:health | chat --input "..." [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] | chain import_json --file <path> | vault init|add|get|list',
      },
      json,
    );
    return;
  }

  if (command === 'chain' && subcommand === 'import_json') {
    if (!file) throw new Error('Missing required --file for chain import_json');
    print(runImportJson(file), json);
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

  if (command === 'chat') {
    if (!input || input.trim().length === 0) {
      throw new Error('Missing required --input for chat command');
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

    printChat(result);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(4);
});
