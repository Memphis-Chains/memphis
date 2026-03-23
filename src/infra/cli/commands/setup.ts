import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { DEFAULT_AGENT_NAME, DEFAULT_OWNER_NAME, writeAgentProfile } from '../../agent-profile.js';
import { enrollOperatorPassphrase } from '../../auth/operator-gate.js';
import { loadConfig } from '../../config/env.js';
import {
  buildSecretAwareness,
  renderSecretAwarenessLines,
  type SecretAwareness,
} from '../../secret-awareness.js';
import { getRustVaultAdapterStatus } from '../../storage/rust-vault-adapter.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type SetupProviderChoice = 'ollama' | 'openai' | 'anthropic' | 'decentralized' | 'custom' | 'local';
type EmbeddingMode = 'local' | 'ollama' | 'openai-compatible';

type SetupAnswers = {
  envPath: string;
  agentName?: string;
  ownerName?: string;
  apiToken?: string;
  provider: SetupProviderChoice;
  providerBaseUrl?: string;
  providerApiKey?: string;
  dataDirectory: string;
  embeddingMode: EmbeddingMode;
  embeddingEndpoint?: string;
  embeddingModel: string;
  vaultPepper: string;
};

type SetupValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

type ConnectivityCheck = {
  ok: boolean;
  target: string;
  statusCode?: number;
  message: string;
};

type SetupResult = {
  ok: boolean;
  envPath: string;
  agentProfilePath: string;
  secretAwareness: SecretAwareness;
  provider: SetupProviderChoice;
  generated: Record<string, string>;
  validation: SetupValidation;
  defaultsUsed: string[];
  nextSteps: string[];
  connectivity?: ConnectivityCheck;
};

const PROVIDER_CHOICES: SetupProviderChoice[] = [
  'ollama',
  'openai',
  'anthropic',
  'decentralized',
  'custom',
  'local',
];
const EMBEDDING_CHOICES: EmbeddingMode[] = ['local', 'ollama', 'openai-compatible'];

const PROVIDER_LABELS: Record<SetupProviderChoice, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  decentralized: 'Decentralized',
  custom: 'Custom OpenAI-compatible',
  local: 'Local-only fallback',
};

function defaultProviderBaseUrl(provider: SetupProviderChoice): string | undefined {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'decentralized':
      return 'https://api.example.com/v1';
    case 'custom':
      return 'https://api.example.com/v1';
    default:
      return undefined;
  }
}

function defaultEmbeddingMode(provider: SetupProviderChoice): EmbeddingMode {
  if (provider === 'ollama') return 'ollama';
  if (provider === 'local') return 'local';
  return 'openai-compatible';
}

function defaultEmbeddingEndpoint(
  provider: SetupProviderChoice,
  providerBaseUrl?: string,
): string | undefined {
  if (provider === 'ollama') {
    return 'http://127.0.0.1:11434/api/embeddings';
  }

  if (!providerBaseUrl) {
    return 'https://api.openai.com/v1/embeddings';
  }

  return `${providerBaseUrl.replace(/\/$/, '')}/embeddings`;
}

function defaultEmbeddingModel(mode: EmbeddingMode): string {
  if (mode === 'ollama') return 'nomic-embed-text';
  if (mode === 'local') return 'local-32d';
  return 'text-embedding-3-small';
}

function generateVaultPepper(): string {
  return `memphis-${randomBytes(16).toString('hex')}`;
}

function generateApiToken(): string {
  return randomBytes(24).toString('base64url');
}

function normalizeDataDirectory(dataDirectory: string): { directory: string; databaseUrl: string } {
  const trimmed = dataDirectory.trim() || './data';
  const cleaned = trimmed.replace(/[\\]+/g, '/').replace(/\/$/, '') || './data';

  if (cleaned.startsWith('/')) {
    return {
      directory: cleaned,
      databaseUrl: `file:${cleaned}/memphis.db`,
    };
  }

  const relative = cleaned.startsWith('./') || cleaned.startsWith('../') ? cleaned : `./${cleaned}`;
  return {
    directory: relative,
    databaseUrl: `file:${relative}/memphis.db`,
  };
}

export function buildSetupEnv(answers: SetupAnswers): {
  env: Record<string, string>;
  validation: SetupValidation;
  defaultsUsed: string[];
  content: string;
} {
  const defaultsUsed: string[] = [];
  const providerBaseUrl =
    answers.providerBaseUrl?.trim() || defaultProviderBaseUrl(answers.provider);
  if (!answers.providerBaseUrl?.trim() && providerBaseUrl) {
    defaultsUsed.push(`provider base URL -> ${providerBaseUrl}`);
  }

  const providerApiKey = answers.providerApiKey?.trim();
  if (!providerApiKey && answers.provider !== 'ollama' && answers.provider !== 'local') {
    defaultsUsed.push('provider API key skipped');
  }

  const embeddingMode = answers.embeddingMode;
  if (embeddingMode === defaultEmbeddingMode(answers.provider)) {
    defaultsUsed.push(`embedding mode -> ${embeddingMode}`);
  }

  const embeddingEndpoint =
    answers.embeddingEndpoint?.trim() ||
    (embeddingMode === 'local'
      ? undefined
      : defaultEmbeddingEndpoint(answers.provider, providerBaseUrl));
  if (!answers.embeddingEndpoint?.trim() && embeddingEndpoint) {
    defaultsUsed.push(`embedding endpoint -> ${embeddingEndpoint}`);
  }

  const embeddingModel = answers.embeddingModel.trim() || defaultEmbeddingModel(embeddingMode);
  if (!answers.embeddingModel.trim()) {
    defaultsUsed.push(`embedding model -> ${embeddingModel}`);
  }

  const normalized = normalizeDataDirectory(answers.dataDirectory);
  if (normalized.directory !== answers.dataDirectory.trim()) {
    defaultsUsed.push(`data directory -> ${normalized.directory}`);
  }

  const env: Record<string, string> = {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    LOG_LEVEL: 'info',
    LOG_FORMAT: 'text',
    MEMPHIS_AGENT_NAME: answers.agentName?.trim() || DEFAULT_AGENT_NAME,
    MEMPHIS_OWNER_NAME: answers.ownerName?.trim() || DEFAULT_OWNER_NAME,
    MEMPHIS_API_TOKEN: answers.apiToken?.trim() || generateApiToken(),
    DATABASE_URL: normalized.databaseUrl,
    MEMPHIS_VAULT_PEPPER: answers.vaultPepper,
    RUST_CHAIN_ENABLED: answers.provider === 'ollama' ? 'true' : 'false',
    LOCAL_FALLBACK_ENABLED: 'true',
    RUST_EMBED_PERSIST_ENABLED: 'true',
    RUST_EMBED_PERSIST_PATH: `${normalized.directory}/embed-index.json`,
  };

  switch (answers.provider) {
    case 'ollama':
      env.DEFAULT_PROVIDER = 'local-fallback';
      env.OLLAMA_URL = 'http://127.0.0.1:11434';
      env.OLLAMA_MODEL = 'qwen2.5-coder:3b';
      break;
    case 'local':
      env.DEFAULT_PROVIDER = 'local-fallback';
      break;
    case 'decentralized':
      env.DEFAULT_PROVIDER = 'decentralized-llm';
      if (providerBaseUrl) env.DECENTRALIZED_LLM_API_BASE = providerBaseUrl;
      if (providerApiKey) env.DECENTRALIZED_LLM_API_KEY = providerApiKey;
      env.DECENTRALIZED_LLM_MODEL = 'gpt-4o-mini';
      break;
    case 'openai':
    case 'anthropic':
    case 'custom':
      env.DEFAULT_PROVIDER = 'shared-llm';
      if (providerBaseUrl) env.SHARED_LLM_API_BASE = providerBaseUrl;
      if (providerApiKey) env.SHARED_LLM_API_KEY = providerApiKey;
      env.SHARED_LLM_MODEL =
        answers.provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini';
      break;
  }

  if (embeddingMode === 'local') {
    env.RUST_EMBED_MODE = 'local';
    env.RUST_EMBED_DIM = '32';
    env.RUST_EMBED_MAX_TEXT_BYTES = '4096';
  } else if (embeddingMode === 'ollama') {
    env.RUST_EMBED_MODE = 'ollama';
    if (embeddingEndpoint) env.RUST_EMBED_PROVIDER_URL = embeddingEndpoint;
    env.RUST_EMBED_PROVIDER_MODEL = embeddingModel;
  } else {
    env.RUST_EMBED_MODE = 'openai-compatible';
    if (embeddingEndpoint) env.RUST_EMBED_PROVIDER_URL = embeddingEndpoint;
    env.RUST_EMBED_PROVIDER_MODEL = embeddingModel;
    if (providerApiKey) env.RUST_EMBED_PROVIDER_API_KEY = providerApiKey;
  }

  const validation = validateSetupEnv(env, answers.provider, providerApiKey);
  const content = renderEnvFile(env, answers.provider);
  return { env, validation, defaultsUsed, content };
}

function renderEnvFile(env: Record<string, string>, provider: SetupProviderChoice): string {
  const orderedKeys = [
    'NODE_ENV',
    'HOST',
    'PORT',
    'LOG_LEVEL',
    'LOG_FORMAT',
    'MEMPHIS_AGENT_NAME',
    'MEMPHIS_OWNER_NAME',
    'DEFAULT_PROVIDER',
    'LOCAL_FALLBACK_ENABLED',
    'SHARED_LLM_API_BASE',
    'SHARED_LLM_API_KEY',
    'SHARED_LLM_MODEL',
    'DECENTRALIZED_LLM_API_BASE',
    'DECENTRALIZED_LLM_API_KEY',
    'DECENTRALIZED_LLM_MODEL',
    'OLLAMA_URL',
    'OLLAMA_MODEL',
    'DATABASE_URL',
    'RUST_CHAIN_ENABLED',
    'RUST_EMBED_MODE',
    'RUST_EMBED_DIM',
    'RUST_EMBED_MAX_TEXT_BYTES',
    'RUST_EMBED_PROVIDER_URL',
    'RUST_EMBED_PROVIDER_API_KEY',
    'RUST_EMBED_PROVIDER_MODEL',
    'RUST_EMBED_PERSIST_ENABLED',
    'RUST_EMBED_PERSIST_PATH',
    'MEMPHIS_VAULT_PEPPER',
  ];

  const lines = [
    `# Generated by memphis setup on ${new Date().toISOString()}`,
    `# Provider preset: ${PROVIDER_LABELS[provider]}`,
    '',
  ];

  for (const key of orderedKeys) {
    const value = env[key];
    if (value === undefined) continue;
    lines.push(`${key}=${value}`);
  }

  lines.push('');
  return lines.join('\n');
}

function validateSetupEnv(
  env: Record<string, string>,
  provider: SetupProviderChoice,
  providerApiKey?: string,
): SetupValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    loadConfig({ ...process.env, ...env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
  }

  if (!env.DATABASE_URL.startsWith('file:')) {
    errors.push('DATABASE_URL must use the file: scheme.');
  }

  if ((env.MEMPHIS_VAULT_PEPPER ?? '').trim().length < 12) {
    errors.push('MEMPHIS_VAULT_PEPPER must be at least 12 characters.');
  }

  if (!providerApiKey && provider !== 'ollama' && provider !== 'local') {
    errors.push(
      'Provider API key was skipped. Set the matching *_API_KEY value before using the selected remote provider.',
    );
    warnings.push('Remote generation is not ready yet because the provider API key is missing.');
  }

  if (provider !== 'ollama' && provider !== 'local') {
    const baseKey =
      provider === 'decentralized' ? 'DECENTRALIZED_LLM_API_BASE' : 'SHARED_LLM_API_BASE';
    if (!(env[baseKey] ?? '').trim()) {
      errors.push(`${baseKey} is required for the selected remote provider.`);
    }
  }

  if (provider === 'ollama') {
    warnings.push(
      'Generation stays on local-fallback today; Ollama values are prepared for local model discovery and embeddings.',
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

async function question(rl: readline.Interface, prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function askChoice<T extends string>(
  rl: readline.Interface,
  label: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  while (true) {
    const answer = await question(rl, `${label} [${defaultValue}] (${choices.join('/')}): `);
    const selected = (answer || defaultValue) as T;
    if (choices.includes(selected)) {
      return selected;
    }
    console.log(`Invalid choice: ${selected}. Allowed values: ${choices.join(', ')}`);
  }
}

async function askYesNo(
  rl: readline.Interface,
  label: string,
  defaultYes = true,
): Promise<boolean> {
  const defaultToken = defaultYes ? 'Y/n' : 'y/N';
  while (true) {
    const answer = (await question(rl, `${label} [${defaultToken}]: `)).toLowerCase();
    if (!answer) return defaultYes;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    console.log('Please answer yes or no.');
  }
}

function ensureWritableEnvPath(envPath: string, force: boolean): string {
  const absolutePath = resolve(envPath);
  if (existsSync(absolutePath) && !force) {
    throw new Error(
      `Refusing to overwrite existing ${absolutePath}; rerun with --force or choose another path.`,
    );
  }
  return absolutePath;
}

async function validateProviderConnectivity(
  env: Record<string, string>,
  provider: SetupProviderChoice,
): Promise<ConnectivityCheck | undefined> {
  if (provider === 'local') {
    return {
      ok: true,
      target: 'local-fallback',
      message: 'Local provider selected, no remote connectivity required.',
    };
  }

  const target =
    provider === 'ollama'
      ? `${env.OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/tags`
      : provider === 'decentralized'
        ? env.DECENTRALIZED_LLM_API_BASE
        : env.SHARED_LLM_API_BASE;

  if (!target) {
    return {
      ok: false,
      target: 'unknown',
      message: 'Provider endpoint is missing in generated configuration.',
    };
  }

  try {
    const response = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (response.ok || response.status < 500) {
      return {
        ok: true,
        target,
        statusCode: response.status,
        message: `Connectivity check reachable (status ${response.status}).`,
      };
    }
    return {
      ok: false,
      target,
      statusCode: response.status,
      message: `Provider endpoint returned status ${response.status}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, target, message: `Connectivity check failed: ${message}` };
  }
}

export async function runSetupWizard(options: {
  outPath?: string;
  force?: boolean;
}): Promise<SetupResult> {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    const envPathAnswer =
      options.outPath ?? ((await question(rl, 'Write .env path [.env]: ')) || '.env');
    const envPath = ensureWritableEnvPath(envPathAnswer, options.force === true);
    const agentName =
      (await question(rl, `Agent name [${DEFAULT_AGENT_NAME}]: `)) || DEFAULT_AGENT_NAME;
    const ownerName =
      (await question(rl, `Owner name [${DEFAULT_OWNER_NAME}]: `)) || DEFAULT_OWNER_NAME;

    const provider = await askChoice(rl, 'Provider', PROVIDER_CHOICES, 'ollama');
    const providerBaseDefault = defaultProviderBaseUrl(provider);
    const providerBaseUrl =
      provider === 'ollama' || provider === 'local'
        ? undefined
        : (await question(
            rl,
            `Provider API base [${providerBaseDefault ?? 'https://api.example.com/v1'}]: `,
          )) ||
          providerBaseDefault ||
          'https://api.example.com/v1';

    const providerApiKey =
      provider === 'ollama' || provider === 'local'
        ? undefined
        : await question(rl, 'Provider API key [optional, leave blank to skip]: ');

    const dataDirectory = (await question(rl, 'Data directory [./data]: ')) || './data';
    const embeddingMode = await askChoice(
      rl,
      'Embedding backend',
      EMBEDDING_CHOICES,
      defaultEmbeddingMode(provider),
    );
    const embeddingEndpoint =
      embeddingMode === 'local'
        ? undefined
        : (await question(
            rl,
            `Embedding endpoint [${defaultEmbeddingEndpoint(provider, providerBaseUrl || providerBaseDefault) ?? ''}]: `,
          )) || undefined;
    const embeddingModel =
      (await question(rl, `Embedding model [${defaultEmbeddingModel(embeddingMode)}]: `)) ||
      defaultEmbeddingModel(embeddingMode);
    const vaultPepper =
      (await question(rl, `Vault pepper [generated secure default]: `)) || generateVaultPepper();

    const built = buildSetupEnv({
      envPath,
      agentName,
      ownerName,
      provider,
      providerBaseUrl: providerBaseUrl || providerBaseDefault,
      providerApiKey,
      dataDirectory,
      embeddingMode,
      embeddingEndpoint,
      embeddingModel,
      vaultPepper,
    });

    // Pre-flight connectivity check BEFORE writing (so user can abort)
    const connectivity = await validateProviderConnectivity(built.env, provider);

    console.log('\nConfiguration summary:');
    console.log(`- Target file: ${envPath}`);
    console.log(`- Provider: ${PROVIDER_LABELS[provider]}`);
    console.log(`- Data directory: ${normalizeDataDirectory(dataDirectory).directory}`);
    console.log(`- Embedding: ${embeddingMode} (${embeddingModel})`);
    if (connectivity && !connectivity.ok) {
      console.log(`- Provider connectivity: FAILED (${connectivity.message})`);
    } else if (connectivity?.ok) {
      console.log('- Provider connectivity: OK');
    }

    // Ollama model check — warn if configured model not pulled locally
    if (provider === 'ollama' && connectivity?.ok) {
      try {
        const ollamaUrl = built.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
        const tagsResp = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (tagsResp.ok) {
          const tagsData = (await tagsResp.json()) as {
            models?: Array<{ name: string }>;
          };
          const models = tagsData.models?.map((m) => m.name) ?? [];
          const embedModel = embeddingModel || 'nomic-embed-text';
          if (!models.some((m) => m.startsWith(embedModel))) {
            console.log(
              `- Ollama model "${embedModel}" not found locally. Run: ollama pull ${embedModel}`,
            );
          }
        }
      } catch {
        // Best-effort check — don't block setup
      }
    }

    const confirmed = await askYesNo(rl, 'Write this configuration now?', true);
    if (!confirmed) {
      throw new Error('Setup cancelled by user before writing files.');
    }

    mkdirSync(resolve(normalizeDataDirectory(dataDirectory).directory), { recursive: true });
    writeFileSync(envPath, built.content, 'utf8');
    const { path: agentProfilePath } = writeAgentProfile({
      agentName: built.env.MEMPHIS_AGENT_NAME,
      ownerName: built.env.MEMPHIS_OWNER_NAME,
    });
    const secretAwareness = buildSecretAwareness({
      envPath,
      agentProfilePath,
      apiToken: built.env.MEMPHIS_API_TOKEN,
      vaultPepper: built.env.MEMPHIS_VAULT_PEPPER,
    });

    // Pre-flight: check Rust bridge before asking for secrets
    const bridgeStatus = getRustVaultAdapterStatus(built.env);
    if (!bridgeStatus.bridgeLoaded || !bridgeStatus.vaultApiAvailable) {
      process.stderr.write('\n⚠️  Rust NAPI bridge not available.\n');
      process.stderr.write('   Vault operations (secret storage) require the Rust bridge.\n');
      process.stderr.write('   Run: npm run build:rust\n\n');
      built.validation.warnings.push(
        'Rust bridge unavailable — vault and embedding features will not work until you run: npm run build:rust',
      );
    }

    if (connectivity && !connectivity.ok) {
      built.validation.warnings.push(connectivity.message);
    }

    // Operator passphrase enrollment (sudo-like gate for dangerous commands)
    const operatorResult = await enrollOperatorPassphrase(rl);
    if (
      !operatorResult.ok &&
      operatorResult.error &&
      !operatorResult.error.includes('already configured')
    ) {
      built.validation.warnings.push(`Operator passphrase: ${operatorResult.error}`);
    }

    return {
      ok: built.validation.ok,
      envPath,
      agentProfilePath,
      secretAwareness,
      provider,
      generated: built.env,
      validation: built.validation,
      defaultsUsed: built.defaultsUsed,
      nextSteps: buildNextSteps(envPath, built.validation),
      connectivity,
    };
  } finally {
    rl.close();
  }
}

function buildNextSteps(envPath: string, validation: SetupValidation): string[] {
  const steps = [
    `Review ${envPath} and fill any missing secrets before production use.`,
    'Run `memphis doctor --json` to verify the environment.',
    'Run `memphis health --json` after the doctor passes.',
    'Initialize the vault with `memphis vault init --passphrase <secret> --recovery-question <q> --recovery-answer <a>`.',
    'For the documented full solo-local runtime, use a cloned repo checkout and start it with `npm run dev`, then open the TUI with `npm run -s cli -- tui`.',
  ];

  if (!validation.ok) {
    steps.unshift('Fix the validation errors below, then rerun `memphis setup --force`.');
  }

  return steps;
}

function printSetupResult(result: SetupResult, asJson: boolean): void {
  if (asJson) {
    print(result, true);
    return;
  }

  console.log(`Wrote ${result.envPath}`);
  console.log(`Agent profile: ${result.agentProfilePath}`);
  console.log(`Provider: ${PROVIDER_LABELS[result.provider]}`);
  for (const line of renderSecretAwarenessLines(result.secretAwareness)) {
    console.log(line);
  }
  if (result.defaultsUsed.length > 0) {
    console.log('Defaults:');
    for (const item of result.defaultsUsed) console.log(`- ${item}`);
  }

  console.log(result.validation.ok ? 'Validation: ok' : 'Validation: failed');
  for (const error of result.validation.errors) console.log(`Error: ${error}`);
  for (const warning of result.validation.warnings) console.log(`Warning: ${warning}`);

  if (result.connectivity) {
    console.log(
      `Connectivity: ${result.connectivity.ok ? 'ok' : 'failed'} (${result.connectivity.target})`,
    );
    console.log(`Connectivity detail: ${result.connectivity.message}`);
  }

  console.log('Next steps:');
  for (const step of result.nextSteps) console.log(`- ${step}`);
}

export async function handleSetupCommand(
  context: CliContext,
  runner: (options: { outPath?: string; force?: boolean }) => Promise<SetupResult> = runSetupWizard,
): Promise<boolean> {
  const { command, subcommand, json, out, force } = context.args;
  if (command !== 'setup' && command !== 'init') return false;
  if (subcommand) {
    throw new Error(`${command} does not take a subcommand`);
  }

  const result = await runner({ outPath: out, force });
  printSetupResult(result, json);
  process.exitCode = result.validation.ok ? 0 : 1;
  return true;
}
