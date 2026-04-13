import chalk from 'chalk';

import { storeVaultSecret } from '../../../security/vault-boundary.js';
import { upsertEnvVars } from '../../config/env-file.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type ProviderName =
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

const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

type ProviderAddResult = {
  ok: boolean;
  provider: ProviderName;
  vaultKey: string;
  envPath: string;
  envRef: string;
  message: string;
  nextSteps?: string[];
};

function renderEnvRefValue(provider: ProviderName): string {
  const cfg = PROVIDERS[provider];
  return cfg.envRef.style === 'vault-prefix' ? `VAULT:${cfg.vaultKey}` : cfg.vaultKey;
}

export async function handleProviderCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, target, json, apiKey } = context.args;

  if (command !== 'provider') return false;

  if (subcommand === 'list' || (!subcommand && !target)) {
    const result = {
      supported: SUPPORTED_PROVIDERS,
      usage: 'memphis provider add <provider> --api-key <key>',
      examples: SUPPORTED_PROVIDERS.map(
        (p) => `memphis provider add ${p} --api-key <key>`,
      ),
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
      throw new Error('--api-key flag is required');
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
        process.env,
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

    const result: ProviderAddResult = {
      ok: true,
      provider,
      vaultKey: config.vaultKey,
      envPath: envUpdate.path,
      envRef: `${config.envRef.envKey}=${envRefValue}`,
      message: `${provider} API key stored encrypted in vault; ${config.envRef.envKey} reference written to ${envUpdate.path}`,
      nextSteps,
    };

    if (!json) {
      console.log(chalk.green.bold('\n✓ Provider configured successfully\n'));
      console.log(`  Provider: ${chalk.cyan(provider)}`);
      console.log(`  Vault key: ${chalk.gray(config.vaultKey)}`);
      console.log(`  Env ref: ${chalk.gray(result.envRef)}`);
      console.log(`  Env file: ${chalk.gray(envUpdate.path)}`);
      console.log(chalk.gray('\n  API key stored encrypted in vault, not in .env.'));
      if (nextSteps.length > 0) {
        console.log('\n  Next steps:');
        for (const step of nextSteps) console.log(`    ${step}`);
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
