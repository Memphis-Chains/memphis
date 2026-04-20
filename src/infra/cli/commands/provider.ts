import { emitKeypressEvents } from 'node:readline';

import chalk from 'chalk';

import { storeVaultSecret } from '../../../security/vault-boundary.js';
import { upsertEnvVars } from '../../config/env-file.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export async function promptHiddenSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    throw new Error(
      `Cannot prompt for ${label}: stdin is not a TTY. Run from an interactive shell so the secret can be prompted privately, or pass --api-key (discouraged, leaks to shell history).`,
    );
  }
  return new Promise<string>((resolvePromise) => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(`${label}: `);
    let value = '';
    const handler = (
      _ch: string | undefined,
      key: { ctrl?: boolean; name?: string; sequence?: string },
    ): void => {
      if (key.ctrl && key.name === 'c') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('keypress', handler);
        stdout.write('\n');
        process.exit(130);
      } else if (key.name === 'return' || key.name === 'enter') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('keypress', handler);
        stdout.write('\n');
        resolvePromise(value);
      } else if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
      } else if (key.sequence && key.sequence.length === 1) {
        const code = key.sequence.charCodeAt(0);
        if (code >= 32 && code !== 127) {
          value += key.sequence;
          stdout.write('*');
        }
      }
    };
    stdin.on('keypress', handler);
  });
}

export type ProviderName =
  | 'anthropic'
  | 'minimax'
  | 'deepseek'
  | 'glm'
  | 'shared-llm'
  | 'decentralized-llm';

type EnvRefStyle =
  | { style: 'vault-key'; envKey: string } // ENVKEY=<vault-entry-name>
  | { style: 'vault-prefix'; envKey: string }; // ENVKEY=VAULT:<vault-entry-name>

interface ProviderConfig {
  vaultKey: string;
  envRef: EnvRefStyle;
}

const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    vaultKey: 'anthropic_api_key',
    envRef: { style: 'vault-key', envKey: 'ANTHROPIC_VAULT_KEY' },
  },
  minimax: {
    vaultKey: 'minimax_api_key',
    envRef: { style: 'vault-key', envKey: 'MINIMAX_VAULT_KEY' },
  },
  deepseek: {
    vaultKey: 'deepseek_api_key',
    envRef: { style: 'vault-key', envKey: 'DEEPSEEK_VAULT_KEY' },
  },
  glm: {
    vaultKey: 'glm_api_key',
    envRef: { style: 'vault-key', envKey: 'GLM_VAULT_KEY' },
  },
  'shared-llm': {
    vaultKey: 'shared_llm_api_key',
    envRef: { style: 'vault-prefix', envKey: 'SHARED_LLM_API_KEY' },
  },
  'decentralized-llm': {
    vaultKey: 'decentralized_llm_api_key',
    envRef: { style: 'vault-prefix', envKey: 'DECENTRALIZED_LLM_API_KEY' },
  },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

export type ProviderAddResult = {
  ok: boolean;
  provider: ProviderName;
  vaultKey: string;
  envPath: string;
  envRef: string;
  message: string;
  nextSteps?: string[];
};

export async function enrollProviderKey(
  provider: ProviderName,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderAddResult> {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unsupported provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    );
  }
  if (!apiKey) {
    throw new Error('API key cannot be empty.');
  }
  if (apiKey.length < 8) {
    throw new Error('API key appears to be invalid (too short)');
  }

  const config = PROVIDERS[provider];

  try {
    storeVaultSecret(
      config.vaultKey,
      apiKey,
      { surface: 'cli', command: 'provider add' },
      env,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (error.includes('vault not initialized')) {
      throw new Error(
        'Vault is not initialized. Run "memphis vault init" first, then retry this command.',
      );
    }
    throw err;
  }

  const envRefValue = renderEnvRefValue(provider);
  const envUpdate = upsertEnvVars([{ key: config.envRef.envKey, value: envRefValue }]);

  const nextSteps: string[] = [];
  if (provider === 'anthropic') {
    nextSteps.push(
      '# Anthropic OAuth is preferred over API key — if you have not yet:',
      'memphis auth anthropic',
    );
  }
  if (provider === 'shared-llm' || provider === 'decentralized-llm') {
    const baseEnv =
      provider === 'shared-llm' ? 'SHARED_LLM_API_BASE' : 'DECENTRALIZED_LLM_API_BASE';
    nextSteps.push(
      `# ${provider} also needs ${baseEnv} set in .env to reach the remote endpoint.`,
    );
  }
  nextSteps.push('memphis doctor        # verify the configuration');

  return {
    ok: true,
    provider,
    vaultKey: config.vaultKey,
    envPath: envUpdate.path,
    envRef: `${config.envRef.envKey}=${envRefValue}`,
    message: `${provider} API key stored encrypted in vault; ${config.envRef.envKey} reference written to ${envUpdate.path}`,
    nextSteps,
  };
}

function renderEnvRefValue(provider: ProviderName): string {
  const cfg = PROVIDERS[provider];
  return cfg.envRef.style === 'vault-prefix' ? `VAULT:${cfg.vaultKey}` : cfg.vaultKey;
}

export async function handleProviderCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, target, json } = context.args;
  let { apiKey } = context.args;

  if (command !== 'provider') return false;

  if (subcommand === 'list' || (!subcommand && !target)) {
    const result = {
      supported: SUPPORTED_PROVIDERS,
      usage: 'memphis provider add <provider> --api-key <key>',
      examples: SUPPORTED_PROVIDERS.map((p) => `memphis provider add ${p} --api-key <key>`),
      note: 'Anthropic OAuth is preferred over API key — use `memphis auth anthropic` for OAuth.',
    };
    print(result, json);
    return true;
  }

  if (subcommand === 'add') {
    if (!target) {
      throw new Error(
        `Provider name required: memphis provider add <${SUPPORTED_PROVIDERS.join('|')}> --api-key <key>`,
      );
    }

    const provider = target.toLowerCase() as ProviderName;
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(
        `Unsupported provider: ${target}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
      );
    }

    if (!apiKey) {
      if (json) {
        throw new Error(
          'provider add --json requires --api-key (no prompts in JSON mode). Omit --json to enter the key interactively.',
        );
      }
      process.stdout.write(`── Provider add: ${provider} ─────────────────────────\n`);
      process.stdout.write('The API key is prompted here instead of being passed on the\n');
      process.stdout.write('command line so it does not leak into your shell history.\n');
      process.stdout.write('It will be stored encrypted in the vault; only a reference\n');
      process.stdout.write('is written to .env.\n\n');
      apiKey = await promptHiddenSecret(`${provider} API key`);
    }

    const result = await enrollProviderKey(provider, apiKey, process.env);

    if (!json) {
      console.log(chalk.green.bold('\n✓ Provider configured successfully\n'));
      console.log(`  Provider: ${chalk.cyan(provider)}`);
      console.log(`  Vault key: ${chalk.gray(result.vaultKey)}`);
      console.log(`  Env ref: ${chalk.gray(result.envRef)}`);
      console.log(`  Env file: ${chalk.gray(result.envPath)}`);
      console.log(chalk.gray('\n  API key stored encrypted in vault, not in .env.'));
      if (result.nextSteps && result.nextSteps.length > 0) {
        console.log('\n  Next steps:');
        for (const step of result.nextSteps) console.log(`    ${step}`);
      }
      console.log();
    }

    print(result, json);
    return true;
  }

  throw new Error(
    `Unknown provider subcommand: ${subcommand}. Use: memphis provider list | add <provider> --api-key <key>`,
  );
}
