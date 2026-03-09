import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
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
import { inferDecisionFromText } from '../../core/decision-gate.js';
import { appendDecisionAudit } from '../../core/decision-audit-log.js';
import { appendDecisionHistory, readDecisionHistory } from '../../core/decision-history-store.js';
import { transitionDecision, type DecisionStatus, type DecisionRecord } from '../../core/decision-lifecycle.js';
import { invokeNativeMcpAsk, type NativeMcpRequest } from '../../bridges/mcp-native-gateway.js';
import { startNativeMcpTransport } from '../../bridges/mcp-native-transport.js';
import {
  buildHostBootstrapPlan,
  checklistFromEnv,
  runHostBootstrapPlan,
  runWizardInteractive,
  writeProfileEnv,
  type WizardProfile,
} from './onboarding-wizard.js';

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
  to?: string;
  latest?: number;
  port?: number;
  durationMs?: number;
  topK?: number;
  tuned?: boolean;
  strategy?: 'default' | 'latency-aware';
  interactive: boolean;
  profile?: WizardProfile;
  force: boolean;
  apply: boolean;
  dryRun: boolean;
  yes: boolean;
  schema: boolean;
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
    to: readFlag('--to'),
    latest: readFlag('--latest') ? Number(readFlag('--latest')) : undefined,
    port: readFlag('--port') ? Number(readFlag('--port')) : undefined,
    durationMs: readFlag('--duration-ms') ? Number(readFlag('--duration-ms')) : undefined,
    topK: readFlag('--top-k') ? Number(readFlag('--top-k')) : undefined,
    tuned: hasFlag('--tuned'),
    strategy: readFlag('--strategy') as CliArgs['strategy'],
    interactive: hasFlag('--interactive'),
    profile: readFlag('--profile') as CliArgs['profile'],
    force: hasFlag('--force'),
    apply: hasFlag('--apply'),
    dryRun: hasFlag('--dry-run'),
    yes: hasFlag('--yes'),
    schema: hasFlag('--schema'),
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
    to,
    latest,
    port,
    durationMs,
    topK,
    tuned,
    strategy,
    interactive,
    profile,
    force,
    apply,
    dryRun,
    yes,
    schema,
  } = parseArgs(argv);

  if (!command || command === 'help' || command === '--help') {
    print(
      {
        usage: 'memphis-v4 <command> [--json]',
        commands:
          'health | providers:health | chat|ask|decide|infer|mcp [serve-once] --input "..." [--schema] [--port <n>] [--to proposed|accepted|implemented|verified|superseded|rejected] [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | tui | doctor | onboarding wizard|bootstrap [--interactive] [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--write --out .env --force] [--dry-run|--apply --yes] | chain import_json --file <path> [--write --confirm-write --out <path>] | vault init|add|get|list | embed store|search [--tuned]|reset',
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

  if (command === 'onboarding' && subcommand === 'bootstrap') {
    const plan = buildHostBootstrapPlan(profile ?? 'dev-local', out ?? '.env', force);
    const execute = apply === true && dryRun !== true;

    if (execute && !yes) {
      throw new Error('onboarding bootstrap --apply requires explicit --yes confirmation');
    }

    if (execute && process.env.NODE_ENV === 'production' && profile !== 'prod-shared' && profile !== 'prod-decentralized') {
      throw new Error('refusing --apply in NODE_ENV=production with non-production profile; use --profile prod-shared|prod-decentralized');
    }

    const result = runHostBootstrapPlan(plan, execute);
    print({ ok: result.ok, mode: result.mode, plan: result.plan, executed: result.executed }, json);
    return;
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

  if (command === 'decide' || command === 'infer') {
    if (command === 'decide' && subcommand === 'history') {
      const all = readDecisionHistory();
      const filtered = id ? all.filter((e) => e.decision.id === id) : all;
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
      return;
    }

    if (command === 'decide' && subcommand === 'transition') {
      if (!input || !to) {
        throw new Error('decide transition requires --input <DecisionRecord JSON> and --to <status>');
      }
      const record = JSON.parse(input) as DecisionRecord;
      const next = transitionDecision(record, to as DecisionStatus);
      const audit = appendDecisionAudit({
        ts: new Date().toISOString(),
        decisionId: record.id,
        action: 'transition',
        from: record.status,
        to,
        actor: 'cli',
      });
      const deterministicHash = createHash('sha256')
        .update(JSON.stringify({ id: record.id, from: record.status, to, updatedAt: next.updatedAt }))
        .digest('hex');

      const historyPath = appendDecisionHistory(next, {
        chainRef: {
          chain: 'decision-history',
          index: Date.now(),
          hash: deterministicHash,
        },
      });
      print({ ok: true, mode: 'decide-transition', from: record.status, to, decision: next, audit, historyPath }, json);
      return;
    }

    if (!input || input.trim().length === 0) {
      throw new Error(`Missing required --input for ${command} command`);
    }
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
    return;
  }

  const config = loadConfig();
  const container = createAppContainer(config);

  if (command === 'mcp') {
    if (subcommand === 'serve') {
      const transport = await startNativeMcpTransport(
        async (request) =>
          invokeNativeMcpAsk(request, async (params) => {
            const result = await container.orchestration.generate({
              input: params.input,
              provider: params.provider ?? 'auto',
              model: params.model,
            });
            return {
              output: result.output,
              providerUsed: result.providerUsed,
              timingMs: result.timingMs,
            };
          }),
        { port: port && Number.isFinite(port) ? Math.trunc(port) : 0 },
      );

      const runMs = durationMs && Number.isFinite(durationMs) && durationMs > 0 ? Math.trunc(durationMs) : 5000;
      print({ ok: true, mode: 'mcp-serve', host: transport.host, port: transport.port, durationMs: runMs }, json);
      await new Promise((resolve) => setTimeout(resolve, runMs));
      await transport.close();
      return;
    }

    if (subcommand === 'serve-once') {
      const transport = await startNativeMcpTransport(
        async (request) =>
          invokeNativeMcpAsk(request, async (params) => {
            const result = await container.orchestration.generate({
              input: params.input,
              provider: params.provider ?? 'auto',
              model: params.model,
            });
            return {
              output: result.output,
              providerUsed: result.providerUsed,
              timingMs: result.timingMs,
            };
          }),
        { port: port && Number.isFinite(port) ? Math.trunc(port) : 0 },
      );

      const requestPayload: NativeMcpRequest = input && input.trim().length
        ? (JSON.parse(input) as NativeMcpRequest)
        : {
            jsonrpc: '2.0',
            id: 'serve-once-default',
            method: 'memphis.ask',
            params: { input: 'serve once probe', provider: 'local-fallback' },
          };

      const responseText = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: transport.host, port: transport.port }, () => {
          client.write(JSON.stringify(requestPayload));
        });
        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        client.on('end', () => resolve(data));
        client.on('error', reject);
      });

      await transport.close();
      const response = JSON.parse(responseText);
      print({ ok: true, mode: 'mcp-serve-once', response, host: transport.host, port: transport.port }, json);
      return;
    }

    if (schema) {
      print(
        {
          ok: true,
          schema: {
            jsonrpc: '2.0',
            methods: [
              {
                name: 'memphis.ask',
                params: {
                  input: 'string (required)',
                  provider: 'auto|shared-llm|decentralized-llm|local-fallback (optional)',
                  model: 'string (optional)',
                },
                result: {
                  output: 'string',
                  providerUsed: 'string',
                  timingMs: 'number',
                },
              },
            ],
            errors: {
              '-32700': 'parse_error: invalid JSON',
              '-32601': 'method_not_allowed',
              '-32602': 'invalid_params',
            },
          },
        },
        json,
      );
      return;
    }

    if (!input || input.trim().length === 0) {
      throw new Error('mcp requires --input with JSON-RPC request payload');
    }

    let request: NativeMcpRequest;
    try {
      request = JSON.parse(input) as NativeMcpRequest;
    } catch {
      const err = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error: invalid JSON' } };
      print({ ok: false, response: err }, json);
      return;
    }

    const allowedMethods = new Set(['memphis.ask']);
    if (!allowedMethods.has(request.method)) {
      const err = {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32601, message: `method_not_allowed: ${String(request.method)}` },
      };
      print({ ok: false, response: err }, json);
      return;
    }

    try {
      const response = await invokeNativeMcpAsk(request, async (params) => {
        const result = await container.orchestration.generate({
          input: params.input,
          provider: params.provider ?? 'auto',
          model: params.model,
        });
        return {
          output: result.output,
          providerUsed: result.providerUsed,
          timingMs: result.timingMs,
        };
      });
      print({ ok: true, response }, json);
      return;
    } catch (error) {
      const err = {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32602, message: error instanceof Error ? error.message : 'invalid_params' },
      };
      print({ ok: false, response: err }, json);
      return;
    }
  }

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
