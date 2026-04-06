import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import {
  applyFirstRunPreview,
  buildFirstRunPlan,
  buildGuidedConversationPreview,
  buildMinimalBaselinePreview,
  inspectFirstRunStatus,
  inspectFirstRunStatusReport,
  type FirstRunMode,
  type FirstRunStatus,
  type GuidedFirstRunAnswers,
} from '../../../onboarding/first-run.js';
import { initializeVault, probeVaultCipherCycle } from '../../../security/vault-boundary.js';
import { DEFAULT_AGENT_NAME, DEFAULT_OWNER_NAME, writeAgentProfile } from '../../agent-profile.js';
import {
  authorizeSession,
  enrollOperatorPassphrase,
  generateSalt,
  hashWithSalt,
  isOperatorConfigured,
  saveOperatorConfig,
  type OperatorConfig,
} from '../../auth/operator-gate.js';
import { loadConfig } from '../../config/env.js';
import { buildHealthPayload } from '../../http/health.js';
import { repairRuntimeState, type RuntimeRepairResult } from '../../runtime/runtime-repair.js';
import {
  buildSecretAwareness,
  type SecretAwareness,
} from '../../secret-awareness.js';
import type { CliContext } from '../context.js';
import {
  generateSecureToken as generateApiToken,
  generateVaultPepper,
  normalizeDataDirectory,
  validateProviderConnectivity,
  checkRustBridgeStatus,
  type ConnectivityCheck,
} from '../utils/onboarding-shared.js';
import { print } from '../utils/render.js';

type SetupProviderChoice = 'ollama' | 'openai' | 'anthropic' | 'decentralized' | 'minimax' | 'deepseek' | 'glm' | 'custom' | 'local';
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
  'minimax',
  'deepseek',
  'glm',
  'custom',
  'local',
];
const EMBEDDING_CHOICES: EmbeddingMode[] = ['local', 'ollama', 'openai-compatible'];

const PROVIDER_LABELS: Record<SetupProviderChoice, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  decentralized: 'Decentralized',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
  glm: 'GLM',
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
    case 'minimax':
      return 'https://api.minimax.io/v1';
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'glm':
      return 'https://open.bigmodel.cn/api/paas/v4';
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
    case 'anthropic':
      env.DEFAULT_PROVIDER = 'anthropic';
      if (providerBaseUrl) env.ANTHROPIC_BASE_URL = providerBaseUrl;
      // Vault-first: store API key reference, not the key itself
      // Actual key will be stored in vault during memphis init
      env.ANTHROPIC_VAULT_KEY = 'anthropic_api_key';
      env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
      break;
    case 'openai':
    case 'custom':
      env.DEFAULT_PROVIDER = 'shared-llm';
      if (providerBaseUrl) env.SHARED_LLM_API_BASE = providerBaseUrl;
      if (providerApiKey) env.SHARED_LLM_API_KEY = providerApiKey;
      env.SHARED_LLM_MODEL = 'gpt-4o-mini';
      break;
    case 'minimax':
      env.DEFAULT_PROVIDER = 'minimax';
      if (providerBaseUrl) env.MINIMAX_BASE_URL = providerBaseUrl;
      // Vault-first: store API key reference, not the key itself
      // Actual key will be stored in vault during memphis init
      env.MINIMAX_VAULT_KEY = 'minimax_api_key';
      env.MINIMAX_MODEL = 'MiniMax-M2.7'; // default model
      break;
    case 'deepseek':
      env.DEFAULT_PROVIDER = 'deepseek';
      if (providerBaseUrl) env.DEEPSEEK_BASE_URL = providerBaseUrl;
      // Vault-first: store API key reference, not the key itself
      // Actual key will be stored in vault during memphis init
      env.DEEPSEEK_VAULT_KEY = 'deepseek_api_key';
      env.DEEPSEEK_MODEL = 'deepseek-chat'; // default model
      break;
    case 'glm':
      env.DEFAULT_PROVIDER = 'glm';
      if (providerBaseUrl) env.GLM_BASE_URL = providerBaseUrl;
      // Vault-first: store API key reference, not the key itself
      // Actual key will be stored in vault during memphis init
      env.GLM_VAULT_KEY = 'glm_api_key';
      env.GLM_MODEL = 'glm-4-flash'; // default model
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
    'MINIMAX_BASE_URL',
    'MINIMAX_VAULT_KEY',
    'MINIMAX_MODEL',
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_VAULT_KEY',
    'DEEPSEEK_MODEL',
    'GLM_BASE_URL',
    'GLM_VAULT_KEY',
    'GLM_MODEL',
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
    `# Generated by memphis init on ${new Date().toISOString()}`,
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

  // Providers that use vault-backed key storage (key stored in vault, not .env)
  const vaultBackedProviders: SetupProviderChoice[] = ['minimax', 'deepseek', 'glm'];

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

  // Skip API key check for vault-backed providers - key will be stored in vault during init
  if (!providerApiKey && provider !== 'ollama' && provider !== 'local' && !vaultBackedProviders.includes(provider)) {
    errors.push(
      'Provider API key was skipped. Set the matching *_API_KEY value before using the selected remote provider.',
    );
    warnings.push('Remote generation is not ready yet because the provider API key is missing.');
  }

  // For vault-backed providers, warn that key enrollment happens during memphis init
  if (!providerApiKey && vaultBackedProviders.includes(provider)) {
    warnings.push(
      `Provider API key will be requested during 'memphis init' and stored securely in vault.`,
    );
  }

  if (provider !== 'ollama' && provider !== 'local') {
    let baseKey: string;
    if (provider === 'decentralized') {
      baseKey = 'DECENTRALIZED_LLM_API_BASE';
    } else if (vaultBackedProviders.includes(provider)) {
      baseKey = `${provider.toUpperCase()}_BASE_URL`;
    } else {
      baseKey = 'SHARED_LLM_API_BASE';
    }
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

    // Vault-backed providers (minimax/deepseek/glm) store keys in vault, not .env
    // Key enrollment happens during 'memphis init' after vault is initialized
    const vaultBackedProviders: SetupProviderChoice[] = ['minimax', 'deepseek', 'glm'];
    const providerApiKey =
      provider === 'ollama' || provider === 'local' || vaultBackedProviders.includes(provider)
        ? undefined
        : await question(rl, 'Provider API key [optional, leave blank to skip]: ');

    if (vaultBackedProviders.includes(provider)) {
      console.log(`\n[${PROVIDER_LABELS[provider]}] API key will be requested securely during 'memphis init' and stored in vault.\n`);
    }

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
    const bridgeStatus = checkRustBridgeStatus(built.env);
    if (bridgeStatus.warnings.length > 0) {
      process.stderr.write('\n⚠️  Rust NAPI bridge not available.\n');
      process.stderr.write('   Vault operations (secret storage) require the Rust bridge.\n');
      process.stderr.write('   Run: npm run build:rust\n\n');
      built.validation.warnings.push(...bridgeStatus.warnings);
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
    'Run `memphis init` to complete controlled first-run, including vault setup and initial chain creation.',
    'For the documented full solo-local runtime, use a cloned repo checkout and start it with `npm run dev`, then open the TUI with `npm run -s cli -- tui`.',
  ];

  if (!validation.ok) {
    steps.unshift('Fix the validation errors below, then rerun `memphis init` from a bootstrapped checkout.');
  }

  return steps;
}

type InitCommandAction =
  | 'status'
  | 'initialized'
  | 'already-initialized'
  | 'legacy-migrated'
  | 'blocked'
  | 'cancelled';

type InitHealthSummary = {
  status: 'healthy' | 'unhealthy';
  repairStatus: 'healthy' | 'degraded-repairable' | 'degraded-manual';
  recommendedAction: string;
};

type InitCommandResult = {
  ok: boolean;
  action: InitCommandAction;
  mode: FirstRunMode | null;
  status: FirstRunStatus;
  repair?: Pick<
    RuntimeRepairResult,
    'ok' | 'status' | 'repairable' | 'recommendedAction' | 'applied' | 'warnings'
  >;
  health?: InitHealthSummary;
  createdChains: string[];
  createdBlocks: number;
  summary: string;
  warnings: string[];
  nextSteps: string[];
};

function createRl(): readline.Interface {
  return readline.createInterface({ input, output, terminal: true });
}

function normalizeFirstRunMode(value: string | undefined): FirstRunMode | null {
  if (!value) return null;
  if (value === 'minimal-baseline' || value === 'guided-conversation') {
    return value;
  }
  throw new Error(
    `invalid --state value: ${value}. Allowed values: minimal-baseline | guided-conversation`,
  );
}

function isNonInteractiveInit(context: CliContext): boolean {
  return (
    context.args.nonInteractive ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stderr.isTTY
  );
}

function summarizeHealthForInit(
  payload: Awaited<ReturnType<typeof buildHealthPayload>>,
): InitHealthSummary {
  return {
    status: payload.status,
    repairStatus: payload.runtime.repair.status,
    recommendedAction: payload.runtime.repair.recommendedAction,
  };
}

function printFirstRunStatusHuman(status: FirstRunStatus): void {
  const plan = buildFirstRunPlan(status, process.env);
  console.log(`first-run state: ${status.state}`);
  console.log(`initialized: ${status.initialized ? 'yes' : 'no'}`);
  console.log(`env: ${status.envPresent ? 'present' : 'missing'}`);
  console.log(`vault: ${status.vaultInitialized ? 'initialized' : 'not initialized'}`);
  console.log(`operator: ${status.operatorConfigured ? 'configured' : 'not configured'}`);
  if (status.record) {
    console.log(`record origin: ${status.record.origin ?? 'controlled-init'}`);
    console.log(`record mode: ${status.record.mode}`);
    console.log(`record summary: ${status.record.summary}`);
  }
  if (status.legacyChains.length > 0) {
    console.log(`legacy chains: ${status.legacyChains.join(', ')}`);
  }
  if (status.reasons.length > 0) {
    console.log('reasons:');
    for (const reason of status.reasons) console.log(`- ${reason}`);
  }
  console.log(`plan summary: ${plan.summary}`);
  console.log(`next command: ${plan.nextCommand}`);
  if (plan.supportedModes.length > 0) {
    console.log(`supported modes: ${plan.supportedModes.join(', ')}`);
  }
  if (plan.preview) {
    console.log(
      `preview minimal-baseline: ${plan.preview.minimalBaseline.createdBlocks} blocks -> ${plan.preview.minimalBaseline.createdChains.join(', ')}`,
    );
    console.log(
      `preview guided-conversation: ${plan.preview.guidedConversation.createdBlocks} blocks -> ${plan.preview.guidedConversation.createdChains.join(', ')}`,
    );
  }
  console.log(`recommended action: ${status.recommendedAction}`);
}

function printInitResult(result: InitCommandResult, asJson: boolean): void {
  if (asJson) {
    print(result, true);
    return;
  }

  const plan = buildFirstRunPlan(result.status, process.env);
  console.log(`init action: ${result.action}`);
  console.log(`first-run state: ${result.status.state}`);
  console.log(`recommended action: ${result.status.recommendedAction}`);
  console.log(`plan: ${plan.summary}`);
  console.log(`next command: ${plan.nextCommand}`);
  if (result.mode) {
    console.log(`mode: ${result.mode}`);
  }
  if (result.summary) {
    console.log(`summary: ${result.summary}`);
  }
  if (result.createdBlocks > 0) {
    console.log(`created blocks: ${result.createdBlocks}`);
    console.log(`created chains: ${result.createdChains.join(', ')}`);
  }
  if (result.repair) {
    console.log(`repair: ${result.repair.status}`);
    for (const item of result.repair.applied) console.log(`  - ${item}`);
  }
  if (result.health) {
    console.log(`health: ${result.health.status} (${result.health.repairStatus})`);
  }
  if (result.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
  if (result.nextSteps.length > 0) {
    console.log('next steps:');
    for (const step of result.nextSteps) console.log(`- ${step}`);
  }
}

async function promptRequired(
  rl: readline.Interface,
  prompt: string,
  fallback?: string,
): Promise<string> {
  while (true) {
    const answer = (await question(rl, fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `)) || fallback || '';
    if (answer.trim().length > 0) {
      return answer.trim();
    }
    console.log('Value is required.');
  }
}

function configureOperatorPassphraseNonInteractive(
  passphrase: string,
  recoveryQuestion: string | undefined,
  recoveryAnswer: string | undefined,
): void {
  if (passphrase.trim().length < 8) {
    throw new Error('operator passphrase must be at least 8 characters');
  }
  const salt = generateSalt();
  const now = new Date().toISOString();
  const recoveryQuestionHint =
    recoveryQuestion?.trim() || 'Configured during non-interactive memphis init';
  const recoveryMaterial = recoveryAnswer?.trim() || passphrase.trim();
  const config: OperatorConfig = {
    schemaVersion: 1,
    passphraseHash: hashWithSalt(passphrase.trim(), salt),
    salt,
    createdAt: now,
    updatedAt: now,
    recoveryQuestionHint,
    recoveryHash: hashWithSalt(recoveryMaterial, salt),
  };
  saveOperatorConfig(config, process.env);
  authorizeSession();
}

async function ensureOperatorPassphraseForInit(
  rl: readline.Interface | null,
  context: CliContext,
  warnings: string[],
): Promise<void> {
  if (isOperatorConfigured(process.env)) return;

  if (isNonInteractiveInit(context)) {
    const passphrase = context.args.operatorPassphrase?.trim();
    if (!passphrase) {
      throw new Error(
        'non-interactive memphis init requires --operator-passphrase when operator gate is not configured',
      );
    }
    configureOperatorPassphraseNonInteractive(
      passphrase,
      context.args.recoveryQuestion,
      context.args.recoveryAnswer,
    );
    warnings.push(
      context.args.recoveryQuestion && context.args.recoveryAnswer
        ? 'operator recovery Q&A was initialized from the provided recovery flags'
        : 'operator recovery answer defaults to the operator passphrase in non-interactive init; rotate it later with memphis operator set-passphrase',
    );
    return;
  }

  if (!rl) {
    throw new Error('interactive operator passphrase setup requires a TTY');
  }
  const result = await enrollOperatorPassphrase(rl, process.env);
  if (!result.ok && result.error) {
    throw new Error(result.error);
  }
}

async function ensureVaultForInit(
  rl: readline.Interface | null,
  context: CliContext,
): Promise<void> {
  const status = inspectFirstRunStatus(process.env);
  if (status.vaultInitialized) {
    const probe = probeVaultCipherCycle({ surface: 'cli', command: 'init' }, process.env);
    if (!probe.ok) {
      throw new Error(probe.error);
    }
    return;
  }

  let passphrase = context.args.passphrase?.trim();
  let recoveryQuestion = context.args.recoveryQuestion?.trim();
  let recoveryAnswer = context.args.recoveryAnswer?.trim();

  if (isNonInteractiveInit(context)) {
    if (!passphrase || !recoveryQuestion || !recoveryAnswer) {
      throw new Error(
        'non-interactive memphis init requires --passphrase --recovery-question --recovery-answer when the vault is not initialized',
      );
    }
  } else {
    if (!rl) {
      throw new Error('interactive vault setup requires a TTY');
    }
    passphrase = passphrase || (await promptRequired(rl, 'Vault passphrase'));
    recoveryQuestion =
      recoveryQuestion || (await promptRequired(rl, 'Vault recovery question'));
    recoveryAnswer = recoveryAnswer || (await promptRequired(rl, 'Vault recovery answer'));
  }

  initializeVault(
    {
      passphrase: passphrase!,
      recovery_question: recoveryQuestion!,
      recovery_answer: recoveryAnswer!,
    },
    { surface: 'cli', command: 'init' },
    process.env,
  );
  const probe = probeVaultCipherCycle({ surface: 'cli', command: 'init' }, process.env);
  if (!probe.ok) {
    throw new Error(probe.error);
  }
}

async function promptFirstRunMode(
  rl: readline.Interface | null,
  context: CliContext,
): Promise<FirstRunMode> {
  const requested = normalizeFirstRunMode(context.args.state);
  if (requested) return requested;
  if (isNonInteractiveInit(context)) return 'minimal-baseline';
  if (!rl) throw new Error('interactive init mode selection requires a TTY');
  return askChoice(
    rl,
    'First-state mode',
    ['guided-conversation', 'minimal-baseline'] as const,
    'guided-conversation',
  );
}

async function promptGuidedAnswers(
  rl: readline.Interface,
): Promise<GuidedFirstRunAnswers> {
  const defaultAgent = process.env.MEMPHIS_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME;
  const defaultOwner = process.env.MEMPHIS_OWNER_NAME?.trim() || DEFAULT_OWNER_NAME;

  const agentName = await promptRequired(rl, 'Agent name', defaultAgent);
  const ownerName = await promptRequired(rl, 'Operator name', defaultOwner);
  const languagesAnswer = await promptRequired(rl, 'Preferred languages (comma separated)', 'pl,en');
  const communicationStyle = await promptRequired(
    rl,
    'Communication style',
    'direct, concise, auditable',
  );
  const purpose = await promptRequired(
    rl,
    'Primary purpose of Memphis',
    'Local-first operator runtime with auditable memory',
  );
  const boundaries = await promptRequired(
    rl,
    'Operator boundaries and constraints',
    'Ask before destructive actions; keep memory transparent and local-first',
  );
  const memoryExpectations = await promptRequired(
    rl,
    'Memory expectations',
    'Remember durable operator context through auditable chains',
  );
  const identityStance = await promptRequired(
    rl,
    'Identity stance',
    'Helpful local operator system, not an autonomous persona',
  );

  return {
    agentName,
    ownerName,
    languages: languagesAnswer
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    communicationStyle,
    purpose,
    boundaries,
    memoryExpectations,
    identityStance,
  };
}

function printPreview(
  mode: FirstRunMode,
  preview: ReturnType<typeof buildMinimalBaselinePreview>,
): void {
  console.log(`first-run preview (${mode})`);
  console.log(`summary: ${preview.summary}`);
  console.log(`chains: ${preview.createdChains.join(', ')}`);
  console.log(`blocks: ${preview.createdBlocks}`);
  for (const block of preview.blocks) {
    console.log(`- ${block.chain}: ${String(block.data.content ?? block.data.type ?? 'block')}`);
  }
}

async function maybeRepairLegacyRuntime(
  context: CliContext,
  rl: readline.Interface | null,
): Promise<RuntimeRepairResult | undefined> {
  const status = inspectFirstRunStatus(process.env);
  if (status.state !== 'legacy-migrateable') return undefined;

  const shouldRepair = isNonInteractiveInit(context)
    ? true
    : rl
      ? await askYesNo(
          rl,
          'Legacy runtime state was detected. Normalize it now before continuing?',
          true,
        )
      : false;

  if (!shouldRepair) {
    throw new Error(
      'legacy runtime state detected; archive the runtime and start clean, or rerun memphis init and accept normalization',
    );
  }

  return repairRuntimeState({ rawEnv: process.env, force: context.args.force });
}

async function buildInitHealthSummary(context: CliContext): Promise<InitHealthSummary> {
  const payload = await buildHealthPayload(context.getConfig(), process.env, {
    workPolling: context.getContainer().workPollingService.snapshot(),
  });
  return summarizeHealthForInit(payload);
}

async function runInitCommand(context: CliContext): Promise<InitCommandResult> {
  const initialStatus = inspectFirstRunStatus(process.env);
  const warnings: string[] = [];
  const nextSteps: string[] = [];

  if (!initialStatus.envPresent) {
    throw new Error('memphis init requires a configured .env file; run npm run bootstrap first');
  }

  if (initialStatus.state === 'legacy-manual') {
    return {
      ok: false,
      action: 'blocked',
      mode: null,
      status: initialStatus,
      createdChains: [],
      createdBlocks: 0,
      summary: '',
      warnings: [],
      nextSteps: [
        'Archive the existing runtime and start clean, or implement a manual legacy chain recovery before normal use.',
      ],
    };
  }

  let repair: RuntimeRepairResult | undefined;
  if (initialStatus.state === 'legacy-migrateable') {
    const rl = isNonInteractiveInit(context) ? null : createRl();
    try {
      repair = await maybeRepairLegacyRuntime(context, rl);
    } finally {
      rl?.close();
    }

    if (repair && repair.status === 'degraded-manual') {
      const status = inspectFirstRunStatus(process.env);
      return {
        ok: false,
        action: 'blocked',
        mode: null,
        status,
        repair: {
          ok: repair.ok,
          status: repair.status,
          repairable: repair.repairable,
          recommendedAction: repair.recommendedAction,
          applied: repair.applied,
          warnings: repair.warnings,
        },
        createdChains: [],
        createdBlocks: 0,
        summary: '',
        warnings: repair.warnings,
        nextSteps: [repair.recommendedAction],
      };
    }
  }

  const status = inspectFirstRunStatus(process.env);
  if (status.state === 'initialized-clean') {
    return {
      ok: true,
      action: repair ? 'legacy-migrated' : 'already-initialized',
      mode: status.record?.mode ?? null,
      status,
      repair: repair
        ? {
            ok: repair.ok,
            status: repair.status,
            repairable: repair.repairable,
            recommendedAction: repair.recommendedAction,
            applied: repair.applied,
            warnings: repair.warnings,
          }
        : undefined,
      health: await buildInitHealthSummary(context),
      createdChains: status.record?.createdChains ?? [],
      createdBlocks: status.record?.createdBlocks ?? 0,
      summary: status.record?.summary ?? '',
      warnings: repair?.warnings ?? [],
      nextSteps: ['Launch Memphis with npm run dev and open the operator TUI with memphis tui.'],
    };
  }

  if (status.state !== 'not-initialized') {
    return {
      ok: false,
      action: 'blocked',
      mode: null,
      status,
      createdChains: [],
      createdBlocks: 0,
      summary: '',
      warnings,
      nextSteps: [status.recommendedAction],
    };
  }

  const rl = isNonInteractiveInit(context) ? null : createRl();
  try {
    await ensureOperatorPassphraseForInit(rl, context, warnings);
    await ensureVaultForInit(rl, context);

    const mode = await promptFirstRunMode(rl, context);
    const preview =
      mode === 'minimal-baseline'
        ? buildMinimalBaselinePreview(process.env)
        : buildGuidedConversationPreview(
            rl
              ? await promptGuidedAnswers(rl)
              : {
                  agentName: process.env.MEMPHIS_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
                  ownerName: process.env.MEMPHIS_OWNER_NAME?.trim() || DEFAULT_OWNER_NAME,
                  languages: ['pl', 'en'],
                  communicationStyle: 'direct, concise, auditable',
                  purpose: 'Local-first operator runtime with auditable memory',
                  boundaries:
                    'Ask before destructive actions; keep memory transparent and local-first',
                  memoryExpectations:
                    'Remember durable operator context through auditable chains',
                  identityStance: 'Helpful local operator system, not an autonomous persona',
                },
          );

    if (rl) {
      console.log('');
      printPreview(mode, preview);
      const confirmed = await askYesNo(rl, 'Apply this first-run plan now?', true);
      if (!confirmed) {
        const cancelledStatus = inspectFirstRunStatus(process.env);
        return {
          ok: false,
          action: 'cancelled',
          mode,
          status: cancelledStatus,
          createdChains: [],
          createdBlocks: 0,
          summary: '',
          warnings,
          nextSteps: ['Rerun memphis init when you are ready to create the first controlled chains.'],
        };
      }
    }

    const applied = await applyFirstRunPreview(preview, process.env);
    const finalStatus = inspectFirstRunStatus(process.env);
    nextSteps.push('Run memphis health --json to verify the runtime is now fully initialized.');
    nextSteps.push('Start the runtime with npm run dev and open memphis tui.');

    return {
      ok: true,
      action: 'initialized',
      mode,
      status: finalStatus,
      health: await buildInitHealthSummary(context),
      createdChains: applied.createdChains,
      createdBlocks: applied.createdBlocks,
      summary: applied.summary,
      warnings,
      nextSteps,
    };
  } finally {
    rl?.close();
  }
}

export async function handleSetupCommand(
  context: CliContext,
  runner: (context: CliContext) => Promise<InitCommandResult> = runInitCommand,
): Promise<boolean> {
  const { command, subcommand, json, out, force } = context.args;
  if (command !== 'setup' && command !== 'init') return false;
  if (subcommand === 'status') {
    const status = inspectFirstRunStatusReport(process.env);
    if (json) {
      print(status, true);
    } else {
      printFirstRunStatusHuman(status);
    }
    process.exitCode = status.state === 'initialized-clean' ? 0 : 1;
    return true;
  }
  if (subcommand) {
    throw new Error(`${command} supports only: ${command} [--state <mode>] [--non-interactive] [--operator-passphrase <secret>] [--passphrase <secret>] [--recovery-question <q>] [--recovery-answer <a>] [--json] | ${command} status [--json]`);
  }
  if (out || force) {
    void out;
    void force;
  }

  const result = await runner(context);
  printInitResult(result, json);
  process.exitCode = result.ok ? 0 : 1;
  return true;
}
