import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';

import { storeVaultSecret } from '../../../security/vault-boundary.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type ProviderName = 'minimax' | 'deepseek' | 'glm';

type ProviderAddResult = {
  ok: boolean;
  provider: ProviderName;
  vaultKey: string;
  envPath: string;
  message: string;
};

const SUPPORTED_PROVIDERS: ProviderName[] = ['minimax', 'deepseek', 'glm'];

const PROVIDER_VAULT_KEYS: Record<ProviderName, string> = {
  minimax: 'minimax_api_key',
  deepseek: 'deepseek_api_key',
  glm: 'glm_api_key',
};

const PROVIDER_ENV_REFS: Record<ProviderName, string> = {
  minimax: 'MINIMAX_VAULT_KEY',
  deepseek: 'DEEPSEEK_VAULT_KEY',
  glm: 'GLM_VAULT_KEY',
};

function findEnvPath(): string {
  // Look for .env in current directory or parent directories
  const candidates = ['.env', '../.env', '../../.env'];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return '.env';
}

function updateEnvFile(envPath: string, provider: ProviderName): void {
  const envRef = PROVIDER_ENV_REFS[provider];
  const vaultKey = PROVIDER_VAULT_KEYS[provider];
  const resolved = resolve(envPath);

  let content = '';
  if (existsSync(resolved)) {
    content = readFileSync(resolved, 'utf8');
  }

  // Check if the line already exists
  const lineToAdd = `${envRef}=${vaultKey}`;
  const regex = new RegExp(`^${envRef}=.*$`, 'm');

  if (regex.test(content)) {
    // Line exists, replace it
    content = content.replace(regex, lineToAdd);
  } else {
    // Add new line
    content = content.trimEnd();
    content += `\n${lineToAdd}\n`;
  }

  writeFileSync(resolved, content, 'utf8');
}

export async function handleProviderCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, target, json, apiKey } = context.args;

  if (command !== 'provider') return false;

  // `memphis provider list` - show supported providers
  if (subcommand === 'list' || (!subcommand && !target)) {
    const result = {
      supported: SUPPORTED_PROVIDERS,
      usage: 'memphis provider add <provider> --api-key <key>',
      examples: [
        'memphis provider add minimax --api-key sk-xxx',
        'memphis provider add deepseek --api-key sk-xxx',
        'memphis provider add glm --api-key sk-xxx',
      ],
    };
    print(result, json);
    return true;
  }

  // `memphis provider add <provider> --api-key <key>`
  if (subcommand === 'add') {
    if (!target) {
      throw new Error('Provider name required: memphis provider add <minimax|deepseek|glm> --api-key <key>');
    }

    const provider = target.toLowerCase() as ProviderName;
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`Unsupported provider: ${target}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }

    if (!apiKey) {
      throw new Error('--api-key flag is required');
    }

    if (apiKey.length < 8) {
      throw new Error('API key appears to be invalid (too short)');
    }

    const vaultKey = PROVIDER_VAULT_KEYS[provider];
    const envPath = findEnvPath();

    try {
      // Store the API key in vault
      storeVaultSecret(
        vaultKey,
        apiKey,
        { surface: 'cli', command: 'provider add' },
        process.env,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (error.includes('vault not initialized')) {
        throw new Error(
          'Vault is not initialized. Run "memphis init" first to initialize the vault, then retry this command.',
        );
      }
      throw err;
    }

    // Update .env with vault reference
    updateEnvFile(envPath, provider);

    const result: ProviderAddResult = {
      ok: true,
      provider,
      vaultKey,
      envPath,
      message: `${provider} API key stored securely in vault and reference added to ${envPath}`,
    };

    if (!json) {
      console.log(chalk.green.bold('\n✓ Provider configured successfully\n'));
      console.log(`  Provider: ${chalk.cyan(provider)}`);
      console.log(`  Vault key: ${chalk.gray(vaultKey)}`);
      console.log(`  Env file: ${chalk.gray(envPath)}`);
      console.log(chalk.gray('\n  The actual API key is stored encrypted in vault, not in .env\n'));
    }

    print(result, json);
    return true;
  }

  throw new Error(`Unknown provider subcommand: ${subcommand}. Use: memphis provider list | add <provider> --api-key <key>`);
}
