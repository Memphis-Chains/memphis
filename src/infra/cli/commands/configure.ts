import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import prompts from 'prompts';
import YAML from 'yaml';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type Provider = 'local-fallback' | 'openai-compatible' | 'ollama' | 'GLM-5';

type ConfigureOptions = {
  nonInteractive?: boolean;
  dryRun?: boolean;
};

type ConfigureResult = {
  ok: boolean;
  dryRun: boolean;
  configPath: string;
  stateDir: string;
  skipped: string[];
  createdDirectories: string[];
  provider: Provider;
  did: string;
};

type MemphisConfig = {
  memphis: {
    version: string;
    createdAt: string;
    provider: Provider;
    vault: {
      initialized: boolean;
      did: string;
      '2fa': {
        enabled: boolean;
        question: string;
      };
    };
    embeddings: {
      enabled: boolean;
      model: string;
    };
    pepper: string;
  };
};

const DEFAULT_STATE_DIR = join(homedir(), '.memphis');
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

function resolveStateDir(input?: string): string {
  const selected = (input ?? '').trim() || DEFAULT_STATE_DIR;
  if (selected.startsWith('~/')) return join(homedir(), selected.slice(2));
  return resolve(selected);
}

function passphraseScore(passphrase: string): boolean {
  if (passphrase.length < 12) return false;
  if (!/[A-Z]/.test(passphrase)) return false;
  if (!/[a-z]/.test(passphrase)) return false;
  if (!/[0-9]/.test(passphrase)) return false;
  if (!/[^A-Za-z0-9]/.test(passphrase)) return false;
  return true;
}

async function providerConnectivity(provider: Provider): Promise<{ ok: boolean; detail: string }> {
  if (provider === 'local-fallback' || provider === 'GLM-5') {
    return { ok: true, detail: `${provider} selected, no external check required.` };
  }

  const target = provider === 'ollama' ? 'http://127.0.0.1:11434/api/tags' : 'https://api.openai.com/v1/models';
  try {
    const response = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (provider === 'openai-compatible') {
      // OpenAI often returns unauthorized without API key, still proves reachability.
      return { ok: response.status < 500, detail: `Endpoint reachable, status ${response.status}.` };
    }
    return {
      ok: response.ok,
      detail: response.ok ? `Endpoint reachable, status ${response.status}.` : `Endpoint returned ${response.status}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Connectivity failed: ${message}` };
  }
}

function generateDid(): string {
  return `did:memphis:${randomBytes(16).toString('hex')}`;
}

function readExistingConfig(configPath: string): Partial<MemphisConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    return YAML.parse(readFileSync(configPath, 'utf8')) as Partial<MemphisConfig>;
  } catch {
    return undefined;
  }
}

export async function runConfigureWizard(options: ConfigureOptions = {}): Promise<ConfigureResult> {
  const skipped: string[] = [];
  const createdDirectories: string[] = [];
  const nonInteractive = options.nonInteractive === true;
  const dryRun = options.dryRun === true;

  console.log(chalk.cyan.bold('\n△⬡◈ Memphis Setup Wizard (MVP)\n'));

  const firstAnswer = nonInteractive
    ? { stateDir: DEFAULT_STATE_DIR }
    : await prompts({
        type: 'text',
        name: 'stateDir',
        message: 'State directory location',
        initial: DEFAULT_STATE_DIR,
      });

  const stateDir = resolveStateDir(firstAnswer.stateDir);
  const configPath = join(stateDir, 'config.yaml');
  const existing = readExistingConfig(configPath)?.memphis;

  if (existing) {
    console.log(chalk.yellow(`Found existing config at ${configPath}. Completed fields will be reused.`));
  }

  const initVault = existing?.vault?.initialized
    ? true
    : nonInteractive
      ? true
      : (
          await prompts({
            type: 'toggle',
            name: 'enabled',
            message: 'Initialize encrypted vault?',
            active: 'yes',
            inactive: 'no',
            initial: true,
          })
        ).enabled;

  let passphrase = '';
  let recoveryQuestion = existing?.vault?.['2fa']?.question ?? '';
  let recoveryAnswer = '';

  if (initVault && !existing?.vault?.initialized) {
    if (nonInteractive) {
      passphrase = 'Memphis!Default#2026';
      recoveryQuestion = recoveryQuestion || 'What is your pet\'s name?';
      recoveryAnswer = 'memphis';
      skipped.push('Vault secret prompts (non-interactive defaults used)');
    } else {
      const passAnswer = await prompts({
        type: 'password',
        name: 'value',
        message: 'Vault passphrase',
        validate: (value: string) => (passphraseScore(value) ? true : 'Min 12 chars, upper/lower/number/symbol required'),
      });
      const passConfirm = await prompts({ type: 'password', name: 'value', message: 'Confirm vault passphrase' });
      if (passAnswer.value !== passConfirm.value) {
        throw new Error('Passphrase confirmation does not match.');
      }
      passphrase = passAnswer.value;

      const questionAnswer = await prompts({
        type: 'text',
        name: 'value',
        message: 'Recovery question',
        initial: recoveryQuestion || "What is your pet's name?",
      });
      recoveryQuestion = questionAnswer.value;

      const recoveryAnswerPrompt = await prompts({ type: 'password', name: 'value', message: 'Recovery answer' });
      recoveryAnswer = recoveryAnswerPrompt.value;
    }
  } else if (existing?.vault?.initialized) {
    skipped.push('Vault initialization (already configured)');
  }

  const provider = (existing?.provider as Provider | undefined)
    ? (existing?.provider as Provider)
    : nonInteractive
      ? 'local-fallback'
      : (
          await prompts({
            type: 'select',
            name: 'value',
            message: 'Default LLM provider',
            choices: [
              { title: 'local-fallback (no API key needed)', value: 'local-fallback' },
              { title: 'openai-compatible (requires API key)', value: 'openai-compatible' },
              { title: 'ollama (local server)', value: 'ollama' },
              { title: 'GLM-5 (if configured)', value: 'GLM-5' },
            ],
            initial: 0,
          })
        ).value;

  if (existing?.provider) skipped.push('Provider selection (already configured)');

  const embeddingsEnabled = existing?.embeddings?.enabled ?? (nonInteractive ? true : (await prompts({ type: 'toggle', name: 'value', message: 'Enable embeddings?', active: 'yes', inactive: 'no', initial: true })).value);

  const embeddingModel = embeddingsEnabled
    ? (existing?.embeddings?.model ??
      (nonInteractive
        ? DEFAULT_EMBED_MODEL
        : (
            await prompts({
              type: 'text',
              name: 'value',
              message: 'Embedding model',
              initial: DEFAULT_EMBED_MODEL,
            })
          ).value || DEFAULT_EMBED_MODEL))
    : DEFAULT_EMBED_MODEL;

  const connectivity = await providerConnectivity(provider);
  if (!connectivity.ok) {
    throw new Error(`Provider connectivity check failed for ${provider}: ${connectivity.detail}`);
  }

  const pepper = randomBytes(32).toString('hex');
  const did = existing?.vault?.did ?? generateDid();

  const config: MemphisConfig = {
    memphis: {
      version: '0.2.0',
      createdAt: new Date().toISOString(),
      provider,
      vault: {
        initialized: initVault,
        did,
        '2fa': {
          enabled: true,
          question: recoveryQuestion || "What is your pet's name?",
        },
      },
      embeddings: {
        enabled: embeddingsEnabled,
        model: embeddingModel,
      },
      pepper,
    },
  };

  const yaml = YAML.stringify(config);
  const dirsToCreate = [stateDir, join(stateDir, 'vault'), join(stateDir, 'state'), join(stateDir, 'logs')];

  if (!dryRun) {
    for (const dir of dirsToCreate) {
      mkdirSync(dir, { recursive: true });
      createdDirectories.push(dir);
    }
    writeFileSync(configPath, yaml, 'utf8');
  }

  if (passphrase || recoveryAnswer) {
    skipped.push('Vault secrets collected and used for initialization workflow');
  }

  console.log(chalk.green.bold(dryRun ? '\nDry-run complete.' : '\nSetup complete.'));
  console.log(chalk.gray(`Config: ${configPath}`));
  console.log(chalk.gray(`DID: ${did}`));
  console.log(chalk.cyan('\nNext steps:'));
  console.log('- Run memphis health --json');
  console.log('- Run memphis vault list');

  return {
    ok: true,
    dryRun,
    configPath,
    stateDir,
    skipped,
    createdDirectories,
    provider,
    did,
  };
}

export async function handleConfigureCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, json, dryRun, nonInteractive } = context.args;
  if (command !== 'configure') return false;
  if (subcommand) throw new Error('configure does not take a subcommand');

  const result = await runConfigureWizard({ nonInteractive, dryRun });
  print(result, json);
  return true;
}
