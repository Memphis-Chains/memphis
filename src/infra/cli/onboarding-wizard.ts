import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
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

export type HostBootstrapExecution = {
  ok: boolean;
  mode: 'dry-run' | 'apply';
  plan: HostBootstrapPlan;
  executed: Array<{ step: string; ok: boolean; output?: string; error?: string; category?: string; attempts?: number }>;
  failedStep?: string;
  errorCategory?: 'dependency' | 'env' | 'runtime' | 'unknown';
  recovery?: string[];
};

export function buildHostBootstrapPlan(profile: WizardProfile, outPath = '.env', force = false): HostBootstrapPlan {
  const forceFlag = force ? ' --force' : '';
  return {
    profile,
    outPath,
    steps: [
      `npm run -s cli -- onboarding wizard --write --profile ${profile} --out ${outPath}${forceFlag}`,
      './scripts/preflight.sh',
      'npm run -s build',
      'npm run -s cli -- doctor --json',
      'npm run -s test:smoke',
      'npm run -s test:smoke:tui',
    ],
  };
}

function clipOutput(value: string, max = 1200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated]`;
}

function classifyBootstrapError(message: string): 'dependency' | 'env' | 'runtime' | 'unknown' {
  const m = message.toLowerCase();
  if (m.includes('command not found') || m.includes('enoent') || m.includes('not installed')) return 'dependency';
  if (m.includes('invalid configuration') || m.includes('required when') || m.includes('refusing') || m.includes('api key')) {
    return 'env';
  }
  if (m.includes('timeout') || m.includes('exit code') || m.includes('failed')) return 'runtime';
  return 'unknown';
}

function shouldRetryStep(step: string): boolean {
  return step.includes('test:smoke') || step.includes('npm run -s build');
}

function recoveryCommands(plan: HostBootstrapPlan, category: 'dependency' | 'env' | 'runtime' | 'unknown'): string[] {
  const head = [`# failure-category: ${category}`];
  const generic = [
    `npm run -s cli -- onboarding wizard --write --profile ${plan.profile} --out ${plan.outPath} --force`,
    './scripts/preflight.sh',
    'npm run -s cli -- doctor --json',
    'npm run -s test:smoke',
    '# fallback: execute bootstrap in dry-run to inspect plan only',
    `npm run -s cli -- onboarding bootstrap --profile ${plan.profile} --out ${plan.outPath} --dry-run --json`,
  ];

  if (category === 'dependency') {
    return [...head, 'npm ci', 'cargo --version || echo "cargo missing"', ...generic];
  }
  if (category === 'env') {
    return [...head, `cat ${plan.outPath}`, 'npm run -s cli -- doctor --json', ...generic];
  }
  return [...head, ...generic];
}

export function runHostBootstrapPlan(plan: HostBootstrapPlan, apply = false): HostBootstrapExecution {
  if (!apply) {
    return {
      ok: true,
      mode: 'dry-run',
      plan,
      executed: plan.steps.map((step) => ({ step, ok: true })),
    };
  }

  const executed: HostBootstrapExecution['executed'] = [];
  for (const step of plan.steps) {
    const maxAttempts = shouldRetryStep(step) ? 2 : 1;
    let attempt = 0;
    let done = false;

    while (attempt < maxAttempts && !done) {
      attempt += 1;
      try {
        const output = execSync(step, {
          cwd: resolve('.'),
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          shell: '/bin/bash',
        });
        executed.push({ step, ok: true, output: clipOutput(output ?? ''), attempts: attempt });
        done = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = classifyBootstrapError(message);
        const retriable = attempt < maxAttempts;

        if (retriable) {
          executed.push({
            step,
            ok: false,
            error: clipOutput(`[attempt ${attempt}/${maxAttempts}] ${message}`),
            category,
            attempts: attempt,
          });
          continue;
        }

        executed.push({ step, ok: false, error: clipOutput(message), category, attempts: attempt });
        return {
          ok: false,
          mode: 'apply',
          plan,
          executed,
          failedStep: step,
          errorCategory: category,
          recovery: recoveryCommands(plan, category),
        };
      }
    }
  }

  return { ok: true, mode: 'apply', plan, executed };
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
