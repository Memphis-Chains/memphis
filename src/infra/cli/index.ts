import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as inputStream, stdout as outputStream } from 'node:process';
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
import { appendDecisionAudit, readDecisionAudit } from '../../core/decision-audit-log.js';
import { appendDecisionHistory, readDecisionHistory } from '../../core/decision-history-store.js';
import { transitionDecision, type DecisionStatus, type DecisionRecord } from '../../core/decision-lifecycle.js';
import {
  appendAskSessionTurn,
  askSessionStats,
  buildAskSessionPrompt,
  clearAskSession,
  estimateTokens,
  readAskSession,
  selectContextTurns,
} from '../../core/ask-session-store.js';
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
import { listConfiguredProviders, listModelsWithCapabilities } from './provider-capabilities.js';

type CompletionShell = 'bash' | 'zsh' | 'fish';

type CliArgs = {
  command?: string;
  subcommand?: string;
  json: boolean;
  tui: boolean;
  write: boolean;
  input?: string;
  session?: string;
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
    session: readFlag('--session'),
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

function generateBashCompletionScript(): string {
  return [
    '# bash completion for memphis',
    '_memphis_completions() {',
    '  local cur prev cmd sub',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  cmd="${COMP_WORDS[1]}"',
    '  sub="${COMP_WORDS[2]}"',
    '',
    '  case "${prev}" in',
    '    --provider)',
    '      COMPREPLY=( $(compgen -W "auto shared-llm decentralized-llm local-fallback" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --strategy)',
    '      COMPREPLY=( $(compgen -W "default latency-aware" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --to)',
    '      COMPREPLY=( $(compgen -W "proposed accepted implemented verified superseded rejected" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --profile)',
    '      COMPREPLY=( $(compgen -W "dev-local prod-shared prod-decentralized ollama-local" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    completion)',
    '      COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '  esac',
    '',
    '  if [[ ${COMP_CWORD} -eq 1 ]]; then',
    '    COMPREPLY=( $(compgen -W "health providers:health providers models chat ask decide infer mcp tui doctor onboarding chain vault embed completion help" -- "${cur}") )',
    '    return 0',
    '  fi',
    '',
    '  if [[ ${COMP_CWORD} -eq 2 ]]; then',
    '    case "${cmd}" in',
    '      providers) COMPREPLY=( $(compgen -W "list" -- "${cur}") ); return 0 ;;',
    '      models) COMPREPLY=( $(compgen -W "list" -- "${cur}") ); return 0 ;;',
    '      decide) COMPREPLY=( $(compgen -W "history transition" -- "${cur}") ); return 0 ;;',
    '      mcp) COMPREPLY=( $(compgen -W "serve serve-once serve-status serve-stop" -- "${cur}") ); return 0 ;;',
    '      onboarding) COMPREPLY=( $(compgen -W "wizard bootstrap" -- "${cur}") ); return 0 ;;',
    '      chain) COMPREPLY=( $(compgen -W "import_json" -- "${cur}") ); return 0 ;;',
    '      vault) COMPREPLY=( $(compgen -W "init add get list" -- "${cur}") ); return 0 ;;',
    '      embed) COMPREPLY=( $(compgen -W "store search reset" -- "${cur}") ); return 0 ;;',
    '      completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") ); return 0 ;;',
    '    esac',
    '  fi',
    '',
    '  local flag_candidates="--json"',
    '  case "${cmd}" in',
    '    chat) flag_candidates="--input --provider --model --tui --interactive --strategy --json" ;;',
    '    ask) flag_candidates="--input --session --provider --model --tui --interactive --strategy --json" ;;',
    '    decide)',
    '      if [[ "${sub}" == "history" ]]; then',
    '        flag_candidates="--id --latest --json"',
    '      elif [[ "${sub}" == "transition" ]]; then',
    '        flag_candidates="--input --to --json"',
    '      else',
    '        flag_candidates="--input --to --latest --id --json"',
    '      fi',
    '      ;;',
    '    infer) flag_candidates="--input --json" ;;',
    '    mcp) flag_candidates="--input --schema --port --duration-ms --json" ;;',
    '    onboarding)',
    '      if [[ "${sub}" == "wizard" ]]; then',
    '        flag_candidates="--interactive --write --profile --out --force --json"',
    '      elif [[ "${sub}" == "bootstrap" ]]; then',
    '        flag_candidates="--profile --out --force --dry-run --apply --yes --json"',
    '      fi',
    '      ;;',
    '    chain)',
    '      if [[ "${sub}" == "import_json" ]]; then flag_candidates="--file --write --confirm-write --out --json"; fi',
    '      ;;',
    '    vault)',
    '      if [[ "${sub}" == "init" ]]; then flag_candidates="--passphrase --recovery-question --recovery-answer --json";',
    '      elif [[ "${sub}" == "add" ]]; then flag_candidates="--key --value --json";',
    '      else flag_candidates="--key --json"; fi',
    '      ;;',
    '    embed)',
    '      if [[ "${sub}" == "store" ]]; then flag_candidates="--id --value --json";',
    '      elif [[ "${sub}" == "search" ]]; then flag_candidates="--query --top-k --tuned --json"; fi',
    '      ;;',
    '    completion) return 0 ;;',
    '  esac',
    '',
    '  COMPREPLY=( $(compgen -W "${flag_candidates}" -- "${cur}") )',
    '  return 0',
    '}',
    'complete -F _memphis_completions memphis',
    'complete -F _memphis_completions memphis-v4',
    '',
  ].join('\n');
}

function generateZshCompletionScript(): string {
  return [
    '#compdef memphis memphis-v4',
    'autoload -Uz bashcompinit',
    'bashcompinit',
    '',
    generateBashCompletionScript(),
  ].join('\n');
}

function generateFishCompletionScript(): string {
  return [
    '# fish completion for memphis / memphis-v4',
    'for c in memphis memphis-v4',
    '  complete -c $c -f -n "__fish_use_subcommand" -a "health providers:health providers models chat ask decide infer mcp tui doctor onboarding chain vault embed completion help"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from providers" -a "list"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from models" -a "list"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from decide" -a "history transition"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from mcp" -a "serve serve-once serve-status serve-stop"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from onboarding" -a "wizard bootstrap"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from chain" -a "import_json"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from vault" -a "init add get list"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from embed" -a "store search reset"',
    '  complete -c $c -l json',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l input',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l provider -a "auto shared-llm decentralized-llm local-fallback"',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l model',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l tui',
    '  complete -c $c -n "__fish_seen_subcommand_from ask" -l session',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l interactive',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l strategy -a "default latency-aware"',
    '  complete -c $c -n "__fish_seen_subcommand_from decide infer mcp" -l input',
    '  complete -c $c -n "__fish_seen_subcommand_from decide" -l to -a "proposed accepted implemented verified superseded rejected"',
    '  complete -c $c -n "__fish_seen_subcommand_from decide history" -l id',
    '  complete -c $c -n "__fish_seen_subcommand_from decide history" -l latest',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l schema',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l port',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l duration-ms',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard bootstrap" -l profile -a "dev-local prod-shared prod-decentralized ollama-local"',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard bootstrap" -l out',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard bootstrap" -l force',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard" -l write',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard" -l interactive',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding bootstrap" -l dry-run',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding bootstrap" -l apply',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding bootstrap" -l yes',
    '  complete -c $c -n "__fish_seen_subcommand_from chain import_json" -l file',
    '  complete -c $c -n "__fish_seen_subcommand_from chain import_json" -l write',
    '  complete -c $c -n "__fish_seen_subcommand_from chain import_json" -l confirm-write',
    '  complete -c $c -n "__fish_seen_subcommand_from vault add get list" -l key',
    '  complete -c $c -n "__fish_seen_subcommand_from vault init" -l passphrase',
    '  complete -c $c -n "__fish_seen_subcommand_from vault init" -l recovery-question',
    '  complete -c $c -n "__fish_seen_subcommand_from vault init" -l recovery-answer',
    '  complete -c $c -n "__fish_seen_subcommand_from vault add" -l value',
    '  complete -c $c -n "__fish_seen_subcommand_from embed store" -l id',
    '  complete -c $c -n "__fish_seen_subcommand_from embed store" -l value',
    '  complete -c $c -n "__fish_seen_subcommand_from embed search" -l query',
    '  complete -c $c -n "__fish_seen_subcommand_from embed search" -l top-k',
    '  complete -c $c -n "__fish_seen_subcommand_from embed search" -l tuned',
    'end',
    '',
  ].join('\n');
}

function generateCompletionScript(shell: CompletionShell): string {
  if (shell === 'bash') return generateBashCompletionScript();
  if (shell === 'zsh') return generateZshCompletionScript();
  return generateFishCompletionScript();
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

function printProvidersHuman(items: Array<{ name: string; status: string; type: string }>): void {
  if (items.length === 0) {
    console.log('No providers configured');
    return;
  }

  for (const item of items) {
    console.log(`${item.name}  status=${item.status}  type=${item.type}`);
  }
}

function printModelsHuman(items: Array<{ provider: string; model: string; capabilities: { supports_streaming: boolean; supports_vision: boolean; context_window: number } }>): void {
  if (items.length === 0) {
    console.log('No models found for configured providers');
    return;
  }

  for (const item of items) {
    const caps = item.capabilities;
    console.log(
      `${item.provider}  ${item.model}  streaming=${caps.supports_streaming} vision=${caps.supports_vision} context=${caps.context_window}`,
    );
  }
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

function printAskSessionContext(name: string, asJson: boolean): void {
  const turns = readAskSession(name, process.env);
  const stats = askSessionStats(turns, process.env);
  if (asJson) {
    print({ ok: true, mode: 'ask-session-context', session: name, ...stats }, true);
    return;
  }
  console.log(`session: ${name}`);
  console.log(`turns: ${stats.turns}`);
  console.log(`tokens: ${stats.tokens}`);
  console.log(`contextTurns: ${stats.contextTurns}`);
  console.log(`contextTokens: ${stats.contextTokens}/${stats.contextTokenLimit}`);
  if (stats.warning) {
    console.log('warning: context window usage is above 80%');
  }
}

async function runAskSessionTurn(params: {
  session: string;
  rawInput: string;
  provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
  model?: string;
  strategy?: 'default' | 'latency-aware';
  json: boolean;
  tui: boolean;
  orchestration: { generate: (input: { input: string; provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback'; model?: string; strategy?: 'default' | 'latency-aware' }) => Promise<{ id: string; providerUsed: string; modelUsed?: string; output: string; timingMs: number; usage?: { outputTokens?: number } ; trace?: { attempts: Array<{ provider: string; ok: boolean; latencyMs: number; viaFallback: boolean; errorCode?: string }> } }> };
}): Promise<{ exit: boolean }> {
  const trimmed = params.rawInput.trim();

  if (trimmed === '/exit') {
    if (params.json) {
      print({ ok: true, mode: 'ask-session-exit', session: params.session }, true);
    } else {
      console.log(`session ${params.session} ended`);
    }
    return { exit: true };
  }

  if (trimmed === '/context') {
    printAskSessionContext(params.session, params.json);
    return { exit: false };
  }

  if (trimmed === '/clear') {
    const path = clearAskSession(params.session, process.env);
    print({ ok: true, mode: 'ask-session-clear', session: params.session, path }, params.json);
    return { exit: false };
  }

  if (trimmed === '/save') {
    const turns = readAskSession(params.session, process.env);
    print({ ok: true, mode: 'ask-session-save', session: params.session, turns: turns.length }, params.json);
    return { exit: false };
  }

  const userTurn = {
    timestamp: new Date().toISOString(),
    role: 'user' as const,
    content: params.rawInput,
    tokens: estimateTokens(params.rawInput),
  };
  appendAskSessionTurn(params.session, userTurn, process.env);

  const turns = readAskSession(params.session, process.env);
  const stats = askSessionStats(turns, process.env);
  const context = selectContextTurns(turns, stats.contextTurns, stats.contextTokenLimit);
  const prompt = buildAskSessionPrompt(context, params.rawInput);

  const result = await params.orchestration.generate({
    input: prompt,
    provider: params.provider,
    model: params.model,
    strategy: params.strategy,
  });

  appendAskSessionTurn(
    params.session,
    {
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content: result.output,
      tokens: result.usage?.outputTokens ?? estimateTokens(result.output),
    },
    process.env,
  );

  const refreshedStats = askSessionStats(readAskSession(params.session, process.env), process.env);
  if (params.json) {
    print({ ...result, session: params.session, context: refreshedStats }, true);
    return { exit: false };
  }

  if (params.tui) {
    printTuiAnswer(result);
  } else {
    printChat(result);
  }

  if (refreshedStats.warning) {
    console.log(`warning: context window nearing limit (${refreshedStats.contextTokens}/${refreshedStats.contextTokenLimit} tokens)`);
  }

  return { exit: false };
}

async function runAskSessionInteractive(params: {
  session: string;
  provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback';
  model?: string;
  strategy?: 'default' | 'latency-aware';
  json: boolean;
  tui: boolean;
  orchestration: { generate: (input: { input: string; provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback'; model?: string; strategy?: 'default' | 'latency-aware' }) => Promise<{ id: string; providerUsed: string; modelUsed?: string; output: string; timingMs: number; usage?: { outputTokens?: number } ; trace?: { attempts: Array<{ provider: string; ok: boolean; latencyMs: number; viaFallback: boolean; errorCode?: string }> } }> };
}): Promise<void> {
  const rl = createInterface({ input: inputStream, output: outputStream });
  console.log(`session mode: ${params.session} (commands: /context /clear /save /exit)`);
  try {
    while (true) {
      const line = await rl.question(`memphis:${params.session}> `);
      if (line.trim().length === 0) continue;
      const outcome = await runAskSessionTurn({ ...params, rawInput: line });
      if (outcome.exit) break;
    }
  } finally {
    rl.close();
  }
}

const MCP_SERVE_STATE_PATH = resolve('data/mcp-serve-state.json');

function writeMcpServeState(state: { pid: number; port: number; startedAt: string; mode: 'running' }): void {
  mkdirSync(resolve('data'), { recursive: true });
  writeFileSync(MCP_SERVE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function readMcpServeState(): { pid: number; port: number; startedAt: string; mode: 'running' } | null {
  if (!existsSync(MCP_SERVE_STATE_PATH)) return null;
  return JSON.parse(readFileSync(MCP_SERVE_STATE_PATH, 'utf8')) as { pid: number; port: number; startedAt: string; mode: 'running' };
}

function clearMcpServeState(): void {
  if (existsSync(MCP_SERVE_STATE_PATH)) unlinkSync(MCP_SERVE_STATE_PATH);
}

type DoctorCheckLevel = 'pass' | 'fail' | 'warn';

type DoctorCheck = {
  id: string;
  title: string;
  level: DoctorCheckLevel;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
  meta?: Record<string, unknown>;
};

const REQUIRED_ENV_KEYS = ['MEMPHIS_VAULT_PEPPER', 'DATABASE_URL', 'DEFAULT_PROVIDER'] as const;

function parseVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const normalized = raw.trim().replace(/^v/, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isVersionAtLeast(raw: string, minMajor: number, minMinor: number): boolean {
  const parsed = parseVersion(raw);
  if (!parsed) return false;
  if (parsed.major !== minMajor) return parsed.major > minMajor;
  return parsed.minor >= minMinor;
}

function canWriteDirectory(path: string): boolean {
  try {
    accessSync(resolve(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

async function checkEndpointReachable(url: string, timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function printDoctorHuman(result: { ok: boolean; checks: DoctorCheck[] }): void {
  const icon = (level: DoctorCheckLevel): string => {
    if (level === 'pass') return '✓';
    if (level === 'warn') return '⚠';
    return '✗';
  };

  console.log(`memphis doctor: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const check of result.checks) {
    console.log(`${icon(check.level)} ${check.title}: ${check.detail}`);
    if (check.fix) console.log(`  fix: ${check.fix}`);
  }
}

async function runDoctorChecks(): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const rustVersionRaw = commandExists('cargo') ? execSync('cargo --version', { encoding: 'utf8' }).trim() : 'missing';
  const rustVersion = rustVersionRaw.split(' ').at(1) ?? '';
  const rustVersionOk = rustVersion !== '' && isVersionAtLeast(rustVersion, 1, 70);
  checks.push({
    id: 'rust-version',
    title: 'Rust version',
    level: rustVersionOk ? 'pass' : 'warn',
    ok: rustVersionOk,
    required: false,
    detail: rustVersionRaw === 'missing' ? 'cargo not found' : `detected ${rustVersionRaw}`,
    fix: 'Install or upgrade Rust: https://rustup.rs (minimum 1.70)',
    meta: { minimum: '1.70.0', detected: rustVersion || null },
  });

  const nodeVersionOk = isVersionAtLeast(process.version, 20, 0);
  checks.push({
    id: 'node-version',
    title: 'Node version',
    level: nodeVersionOk ? 'pass' : 'warn',
    ok: nodeVersionOk,
    required: false,
    detail: `detected ${process.version}`,
    fix: 'Upgrade Node.js to 20+ (recommended current LTS).',
    meta: { minimum: '20.0.0', detected: process.version },
  });

  const dataWritable = canWriteDirectory('data');
  const distWritable = canWriteDirectory('dist');
  checks.push({
    id: 'permissions',
    title: 'Write permissions',
    level: dataWritable && distWritable ? 'pass' : 'fail',
    ok: dataWritable && distWritable,
    required: true,
    detail: `data/: ${dataWritable ? 'writable' : 'not writable'}, dist/: ${distWritable ? 'writable' : 'not writable'}`,
    fix: 'Ensure current user has write access: chmod -R u+rw data dist',
    meta: { dataWritable, distWritable },
  });

  const envPath = resolve('.env');
  const envExists = existsSync(envPath);
  const envValues = parseEnvFile(envPath);
  const missingEnvKeys = REQUIRED_ENV_KEYS.filter((k) => !envValues[k] || envValues[k].length === 0);
  checks.push({
    id: 'env-file',
    title: '.env required keys',
    level: envExists && missingEnvKeys.length === 0 ? 'pass' : 'fail',
    ok: envExists && missingEnvKeys.length === 0,
    required: true,
    detail: envExists ? (missingEnvKeys.length === 0 ? 'all required keys are set' : `missing keys: ${missingEnvKeys.join(', ')}`) : '.env is missing',
    fix: 'Copy .env.example to .env and populate required keys.',
    meta: { envFilePresent: envExists, requiredKeys: REQUIRED_ENV_KEYS, missingKeys: missingEnvKeys },
  });

  const distPath = resolve('dist');
  const distExists = existsSync(distPath);
  const distEntries = distExists ? readdirSync(distPath) : [];
  checks.push({
    id: 'build-artifacts',
    title: 'Build artifacts',
    level: distExists && distEntries.length > 0 ? 'pass' : 'fail',
    ok: distExists && distEntries.length > 0,
    required: true,
    detail: distExists ? `dist/ contains ${distEntries.length} entries` : 'dist/ directory is missing',
    fix: 'Run npm run build to generate artifacts.',
    meta: { distExists, entries: distEntries.length },
  });

  const embedMode = process.env.RUST_EMBED_MODE ?? envValues.RUST_EMBED_MODE ?? 'local';
  const providerUrl = process.env.RUST_EMBED_PROVIDER_URL ?? envValues.RUST_EMBED_PROVIDER_URL;
  let endpointToCheck: string | null = null;
  if (embedMode === 'ollama') {
    endpointToCheck = 'http://127.0.0.1:11434/api/tags';
  } else if (embedMode === 'provider' || embedMode === 'openai-compatible') {
    endpointToCheck = providerUrl ?? null;
  }
  const embedReachable = endpointToCheck ? await checkEndpointReachable(endpointToCheck) : true;
  checks.push({
    id: 'embedding-provider',
    title: 'Embedding provider endpoint',
    level: embedReachable ? 'pass' : 'warn',
    ok: embedReachable,
    required: false,
    detail: endpointToCheck ? `${endpointToCheck} is ${embedReachable ? 'reachable' : 'unreachable'}` : `mode=${embedMode} (no remote reachability check required)`,
    fix: endpointToCheck ? 'Start the provider service or correct endpoint URL in .env.' : undefined,
    meta: { embedMode, endpoint: endpointToCheck },
  });

  const port = Number(process.env.PORT ?? envValues.PORT ?? 3000);
  const mcpEndpoint = `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}/health`;
  const mcpReachable = await checkEndpointReachable(mcpEndpoint);
  checks.push({
    id: 'mcp-service',
    title: 'MCP service/port availability',
    level: mcpReachable ? 'pass' : 'warn',
    ok: mcpReachable,
    required: false,
    detail: mcpReachable ? `service responds on port ${port}` : `no service detected on port ${port}`,
    fix: 'If MCP should be running, start it with memphis-v4 mcp serve.',
    meta: { port, reachable: mcpReachable },
  });

  const ok = checks.every((check) => !check.required || check.level === 'pass');
  return { ok, checks };
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const {
    command,
    subcommand,
    json,
    tui,
    write,
    input,
    session,
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
          'health | providers:health | providers list | models list | chat|ask|decide|infer|mcp [serve|serve-once|serve-status|serve-stop] --input "..." [--session <name>] [--schema] [--port <n>] [--duration-ms <n>] [--to proposed|accepted|implemented|verified|superseded|rejected] [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware] | tui | doctor | onboarding wizard|bootstrap [--interactive] [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--write --out .env --force] [--dry-run|--apply --yes] | chain import_json --file <path> [--write --confirm-write --out <path>] | vault init|add|get|list | embed store|search [--tuned]|reset | completion <bash|zsh|fish>',
      },
      json,
    );
    return;
  }

  if (command === 'completion') {
    const shell = subcommand as CompletionShell | undefined;
    if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
      throw new Error('completion requires shell argument: bash | zsh | fish');
    }
    const script = generateCompletionScript(shell);
    process.stdout.write(script);
    if (!script.endsWith('\n')) {
      process.stdout.write('\n');
    }
    return;
  }

  if (command === 'doctor') {
    const report = await runDoctorChecks();
    if (json) {
      print(report, true);
    } else {
      printDoctorHuman(report);
    }
    process.exitCode = report.ok ? 0 : 1;
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
      const auditIndex = readDecisionAudit().length;
      const deterministicHash = createHash('sha256')
        .update(JSON.stringify({
          eventId: audit.eventId,
          id: record.id,
          from: record.status,
          to,
          updatedAt: next.updatedAt,
          correlationId,
        }))
        .digest('hex');

      const historyPath = appendDecisionHistory(next, {
        correlationId,
        chainRef: {
          chain: 'decision-audit',
          index: auditIndex,
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

  if (command === 'providers' && subcommand === 'list') {
    const providers = listConfiguredProviders(process.env);
    if (json) {
      print({ providers }, true);
      return;
    }
    printProvidersHuman(providers);
    return;
  }

  if (command === 'models' && subcommand === 'list') {
    const models = await listModelsWithCapabilities(process.env);
    if (json) {
      print({ models }, true);
      return;
    }
    printModelsHuman(models);
    return;
  }

  const config = loadConfig();
  const container = createAppContainer(config);

  if (command === 'mcp') {
    if (subcommand === 'serve-status') {
      const state = readMcpServeState();
      if (!state) {
        print({ ok: false, mode: 'mcp-serve-status', running: false }, json);
        return;
      }
      let running = true;
      try {
        process.kill(state.pid, 0);
      } catch {
        running = false;
      }
      print({ ok: true, mode: 'mcp-serve-status', running, state }, json);
      return;
    }

    if (subcommand === 'serve-stop') {
      const state = readMcpServeState();
      if (!state) {
        print({ ok: true, mode: 'mcp-serve-stop', stopped: false, reason: 'no-state' }, json);
        return;
      }
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // noop
      }
      clearMcpServeState();
      print({ ok: true, mode: 'mcp-serve-stop', stopped: true, pid: state.pid }, json);
      return;
    }

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

      const runMs = durationMs && Number.isFinite(durationMs) ? Math.trunc(durationMs) : 5000;
      let stopRequested = false;
      const stop = () => {
        stopRequested = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      writeMcpServeState({ pid: process.pid, port: transport.port, startedAt: new Date().toISOString(), mode: 'running' });
      print({ ok: true, mode: 'mcp-serve', host: transport.host, port: transport.port, durationMs: runMs }, json);

      const startedAt = Date.now();
      while (!stopRequested && (runMs <= 0 || Date.now() - startedAt < runMs)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await transport.close();
      clearMcpServeState();
      print({ ok: true, mode: 'mcp-serve-stopped', reason: stopRequested ? 'signal' : 'timeout' }, json);
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
    if (session && command !== 'ask') {
      throw new Error('--session is supported only for ask command');
    }

    if (command === 'ask' && session) {
      if (interactive && (!input || input.trim().length === 0)) {
        await runAskSessionInteractive({
          session,
          orchestration: container.orchestration,
          provider: provider ?? 'auto',
          model,
          strategy,
          json,
          tui,
        });
        return;
      }

      if (!input || input.trim().length === 0) {
        throw new Error('Missing required --input for ask command in session mode (or use --interactive)');
      }

      await runAskSessionTurn({
        session,
        rawInput: input,
        orchestration: container.orchestration,
        provider: provider ?? 'auto',
        model,
        strategy,
        json,
        tui,
      });
      return;
    }

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
