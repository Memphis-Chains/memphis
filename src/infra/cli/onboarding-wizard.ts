import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export type WizardProfile = 'dev-local' | 'prod-shared' | 'prod-decentralized' | 'ollama-local';

const profileTemplates: Record<WizardProfile, string> = {
  'dev-local': `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3000\nLOG_LEVEL=debug\nDEFAULT_PROVIDER=local-fallback\nLOCAL_FALLBACK_ENABLED=true\nRUST_CHAIN_ENABLED=false\nRUST_EMBED_MODE=local\nRUST_EMBED_DIM=32\nRUST_EMBED_MAX_TEXT_BYTES=4096\nMEMPHIS_VAULT_PEPPER=change-this-pepper\n`,
  'prod-shared': `NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nLOG_LEVEL=info\nMEMPHIS_API_TOKEN=change-this-token\nDEFAULT_PROVIDER=shared-llm\nSHARED_LLM_API_BASE=\nSHARED_LLM_API_KEY=\nRUST_CHAIN_ENABLED=true\nRUST_EMBED_MODE=openai-compatible\nRUST_EMBED_PROVIDER_URL=https://api.openai.com/v1/embeddings\nRUST_EMBED_PROVIDER_MODEL=text-embedding-3-small\nRUST_EMBED_PROVIDER_API_KEY=\nMEMPHIS_VAULT_PEPPER=change-this-pepper\n`,
  'prod-decentralized': `NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nLOG_LEVEL=info\nMEMPHIS_API_TOKEN=change-this-token\nDEFAULT_PROVIDER=decentralized-llm\nDECENTRALIZED_LLM_API_BASE=\nDECENTRALIZED_LLM_API_KEY=\nRUST_CHAIN_ENABLED=true\nRUST_EMBED_MODE=openai-compatible\nRUST_EMBED_PROVIDER_URL=https://api.openai.com/v1/embeddings\nRUST_EMBED_PROVIDER_MODEL=text-embedding-3-small\nRUST_EMBED_PROVIDER_API_KEY=\nMEMPHIS_VAULT_PEPPER=change-this-pepper\n`,
  'ollama-local': `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3000\nLOG_LEVEL=debug\nDEFAULT_PROVIDER=local-fallback\nRUST_CHAIN_ENABLED=true\nRUST_EMBED_MODE=ollama\nRUST_EMBED_PROVIDER_URL=http://127.0.0.1:11434/api/embeddings\nRUST_EMBED_PROVIDER_MODEL=nomic-embed-text\nMEMPHIS_VAULT_PEPPER=change-this-pepper\n`,
};

export function generateEnvProfile(profile: WizardProfile): string {
  return profileTemplates[profile];
}

export function checklistFromEnv(rawEnv: NodeJS.ProcessEnv): Array<{ step: string; done: boolean; note: string }> {
  return [
    { step: 'env-file', done: existsSync(resolve('.env')), note: 'Create .env from .env.example or --profile template' },
    {
      step: 'rust-bridge',
      done: (rawEnv.RUST_CHAIN_ENABLED ?? '').toLowerCase() === 'true',
      note: 'Set RUST_CHAIN_ENABLED=true when using rust bridge',
    },
    {
      step: 'vault-pepper',
      done: (rawEnv.MEMPHIS_VAULT_PEPPER ?? '').length >= 12,
      note: 'Set MEMPHIS_VAULT_PEPPER (>=12 chars)',
    },
    { step: 'provider', done: Boolean(rawEnv.DEFAULT_PROVIDER), note: 'Choose DEFAULT_PROVIDER' },
    {
      step: 'embed-mode',
      done: ['local', 'openai-compatible', 'provider', 'ollama', 'cohere', 'voyage', 'jina', 'mistral', 'together', 'nvidia', 'mixedbread'].includes(
        (rawEnv.RUST_EMBED_MODE ?? 'local').toLowerCase(),
      ),
      note: 'Set RUST_EMBED_MODE to local/openai-compatible/ollama/cohere/voyage/jina/mistral/together/nvidia/mixedbread',
    },
  ];
}

export function writeProfileEnv(profile: WizardProfile, outPath = '.env', force = false): { path: string; profile: WizardProfile } {
  const abs = resolve(outPath);
  if (existsSync(abs) && !force) {
    throw new Error(`Refusing to overwrite existing ${abs}; pass --force to overwrite`);
  }
  writeFileSync(abs, generateEnvProfile(profile), 'utf8');
  return { path: abs, profile };
}

export type HostBootstrapPlan = {
  profile: WizardProfile;
  outPath: string;
  steps: string[];
};

export function buildHostBootstrapPlan(profile: WizardProfile, outPath = '.env'): HostBootstrapPlan {
  return {
    profile,
    outPath,
    steps: [
      `npm run -s cli -- onboarding wizard --write --profile ${profile} --out ${outPath}`,
      './scripts/preflight.sh',
      'npm run -s build',
      'npm run -s cli -- doctor --json',
      'npm run -s test:smoke',
      'npm run -s test:smoke:tui',
    ],
  };
}

export async function runWizardInteractive(defaultProfile: WizardProfile = 'dev-local'): Promise<{ profile: WizardProfile; written: string }> {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    const pickedRaw = await rl.question(`Profile [${defaultProfile}] (dev-local|prod-shared|prod-decentralized|ollama-local): `);
    const picked = (pickedRaw.trim() || defaultProfile) as WizardProfile;
    if (!(picked in profileTemplates)) {
      throw new Error(`unknown profile: ${picked}`);
    }

    const outPathRaw = await rl.question('Write .env path [.env]: ');
    const outPath = outPathRaw.trim() || '.env';
    const forceRaw = await rl.question('Overwrite if exists? [y/N]: ');
    const force = ['y', 'yes'].includes(forceRaw.trim().toLowerCase());
    const result = writeProfileEnv(picked, outPath, force);
    return { profile: picked, written: result.path };
  } finally {
    rl.close();
  }
}
