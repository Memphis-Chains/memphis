import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { vaultInit } from '../storage/rust-vault-adapter.js';

export type WizardProfile = 'dev-local' | 'prod-shared' | 'prod-decentralized' | 'ollama-local';

export type WizardSecrets = {
  apiToken: string;
  vaultPepper: string;
};

export type VaultSetupResult = {
  ok: boolean;
  skipped: boolean;
  error?: string;
};

export type WizardResult = {
  profile: WizardProfile;
  written: string;
  secrets: WizardSecrets;
  vault: VaultSetupResult;
};

// ── Key generation ────────────────────────────────────────────────────────────

export function generateSecureToken(): string {
  return randomBytes(24).toString('base64url');
}

// ── Profile templates ─────────────────────────────────────────────────────────

function buildProfileEnv(profile: WizardProfile, secrets: WizardSecrets): string {
  const { apiToken, vaultPepper } = secrets;

  const base: Record<WizardProfile, string> = {
    'dev-local': [
      'NODE_ENV=development',
      'HOST=127.0.0.1',
      'PORT=3000',
      'LOG_LEVEL=debug',
      `MEMPHIS_API_TOKEN=${apiToken}`,
      'DEFAULT_PROVIDER=local-fallback',
      'LOCAL_FALLBACK_ENABLED=true',
      'RUST_CHAIN_ENABLED=false',
      'RUST_EMBED_MODE=local',
      'RUST_EMBED_DIM=32',
      'RUST_EMBED_MAX_TEXT_BYTES=4096',
      `MEMPHIS_VAULT_PEPPER=${vaultPepper}`,
      '',
    ].join('\n'),
    'prod-shared': [
      'NODE_ENV=production',
      'HOST=0.0.0.0',
      'PORT=3000',
      'LOG_LEVEL=info',
      `MEMPHIS_API_TOKEN=${apiToken}`,
      'DEFAULT_PROVIDER=shared-llm',
      'SHARED_LLM_API_BASE=',
      'SHARED_LLM_API_KEY=',
      'RUST_CHAIN_ENABLED=true',
      'RUST_EMBED_MODE=openai-compatible',
      'RUST_EMBED_PROVIDER_URL=https://api.openai.com/v1/embeddings',
      'RUST_EMBED_PROVIDER_MODEL=text-embedding-3-small',
      'RUST_EMBED_PROVIDER_API_KEY=',
      `MEMPHIS_VAULT_PEPPER=${vaultPepper}`,
      '',
    ].join('\n'),
    'prod-decentralized': [
      'NODE_ENV=production',
      'HOST=0.0.0.0',
      'PORT=3000',
      'LOG_LEVEL=info',
      `MEMPHIS_API_TOKEN=${apiToken}`,
      'DEFAULT_PROVIDER=decentralized-llm',
      'DECENTRALIZED_LLM_API_BASE=',
      'DECENTRALIZED_LLM_API_KEY=',
      'RUST_CHAIN_ENABLED=true',
      'RUST_EMBED_MODE=openai-compatible',
      'RUST_EMBED_PROVIDER_URL=https://api.openai.com/v1/embeddings',
      'RUST_EMBED_PROVIDER_MODEL=text-embedding-3-small',
      'RUST_EMBED_PROVIDER_API_KEY=',
      `MEMPHIS_VAULT_PEPPER=${vaultPepper}`,
      '',
    ].join('\n'),
    'ollama-local': [
      'NODE_ENV=development',
      'HOST=127.0.0.1',
      'PORT=3000',
      'LOG_LEVEL=debug',
      `MEMPHIS_API_TOKEN=${apiToken}`,
      'DEFAULT_PROVIDER=local-fallback',
      'RUST_CHAIN_ENABLED=true',
      'RUST_EMBED_MODE=ollama',
      'RUST_EMBED_PROVIDER_URL=http://127.0.0.1:11434/api/embeddings',
      'RUST_EMBED_PROVIDER_MODEL=nomic-embed-text',
      `MEMPHIS_VAULT_PEPPER=${vaultPepper}`,
      '',
    ].join('\n'),
  };

  return base[profile];
}

export function generateEnvProfile(profile: WizardProfile, secrets?: WizardSecrets): string {
  const resolved = secrets ?? {
    apiToken: 'change-this-token',
    vaultPepper: 'change-this-pepper',
  };
  return buildProfileEnv(profile, resolved);
}

// ── Credential sheet ──────────────────────────────────────────────────────────

export function formatCredentialSheet(
  secrets: WizardSecrets,
  passphrase: string,
  recoveryQuestion: string,
  recoveryAnswer: string,
): string {
  const line = '─'.repeat(52);
  return [
    '',
    line,
    '  MEMPHIS CREDENTIALS — SAVE THIS NOW',
    line,
    '',
    `  MEMPHIS_API_TOKEN   ${secrets.apiToken}`,
    `  MEMPHIS_VAULT_PEPPER  ${secrets.vaultPepper}`,
    '',
    `  VAULT_PASSPHRASE    ${passphrase}`,
    `  RECOVERY_QUESTION   ${recoveryQuestion}`,
    `  RECOVERY_ANSWER     ${recoveryAnswer}`,
    '',
    '  Store in a password manager. Losing the pepper or',
    '  passphrase makes vault entries unrecoverable.',
    '',
    line,
    '',
  ].join('\n');
}

// ── Vault setup ───────────────────────────────────────────────────────────────

export async function runVaultSetupInteractive(
  rl: readline.Interface,
  pepper: string,
): Promise<{ result: VaultSetupResult; passphrase: string; question: string; answer: string }> {
  console.log('\nVault setup — your secrets will be encrypted at rest.\n');

  const skipRaw = await rl.question('Set up vault now? [Y/n]: ');
  if (['n', 'no'].includes(skipRaw.trim().toLowerCase())) {
    return {
      result: { ok: true, skipped: true },
      passphrase: '',
      question: '',
      answer: '',
    };
  }

  const passphrase = await rl.question('Vault passphrase (master password): ');
  if (!passphrase.trim()) {
    return {
      result: { ok: false, skipped: false, error: 'passphrase cannot be empty' },
      passphrase: '',
      question: '',
      answer: '',
    };
  }

  const question = await rl.question('Recovery question (e.g. "Name of first pet?"): ');
  const answer = await rl.question('Recovery answer: ');

  try {
    const envWithPepper = { ...process.env, MEMPHIS_VAULT_PEPPER: pepper };
    vaultInit(
      {
        passphrase: passphrase.trim(),
        recovery_question: question.trim(),
        recovery_answer: answer.trim(),
      },
      envWithPepper,
    );
    return {
      result: { ok: true, skipped: false },
      passphrase: passphrase.trim(),
      question: question.trim(),
      answer: answer.trim(),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      result: { ok: false, skipped: false, error: msg },
      passphrase: passphrase.trim(),
      question: question.trim(),
      answer: answer.trim(),
    };
  }
}

// ── Checklist ─────────────────────────────────────────────────────────────────

export function checklistFromEnv(
  rawEnv: NodeJS.ProcessEnv,
): Array<{ step: string; done: boolean; note: string }> {
  return [
    {
      step: 'env-file',
      done: existsSync(resolve('.env')),
      note: 'Create .env from .env.example or --profile template',
    },
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
      done: [
        'local',
        'openai-compatible',
        'provider',
        'ollama',
        'cohere',
        'voyage',
        'jina',
        'mistral',
        'together',
        'nvidia',
        'mixedbread',
      ].includes((rawEnv.RUST_EMBED_MODE ?? 'local').toLowerCase()),
      note: 'Set RUST_EMBED_MODE to local/openai-compatible/ollama/cohere/voyage/jina/mistral/together/nvidia/mixedbread',
    },
  ];
}

// ── Profile writer ────────────────────────────────────────────────────────────

export function writeProfileEnv(
  profile: WizardProfile,
  outPath = '.env',
  force = false,
  secrets?: WizardSecrets,
): { path: string; profile: WizardProfile } {
  const abs = resolve(outPath);
  if (existsSync(abs) && !force) {
    throw new Error(`Refusing to overwrite existing ${abs}; pass --force to overwrite`);
  }
  writeFileSync(abs, generateEnvProfile(profile, secrets), 'utf8');
  return { path: abs, profile };
}

// ── Bootstrap plan ────────────────────────────────────────────────────────────

export type HostBootstrapPlan = {
  profile: WizardProfile;
  outPath: string;
  steps: string[];
};

export type HostBootstrapExecution = {
  ok: boolean;
  mode: 'dry-run' | 'apply';
  plan: HostBootstrapPlan;
  executed: Array<{
    step: string;
    ok: boolean;
    output?: string;
    error?: string;
    category?: string;
    attempts?: number;
  }>;
  failedStep?: string;
  errorCategory?: 'dependency' | 'env' | 'runtime' | 'unknown';
  recovery?: string[];
};

export function buildHostBootstrapPlan(
  profile: WizardProfile,
  outPath = '.env',
  force = false,
): HostBootstrapPlan {
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
  if (m.includes('command not found') || m.includes('enoent') || m.includes('not installed'))
    return 'dependency';
  if (
    m.includes('invalid configuration') ||
    m.includes('required when') ||
    m.includes('refusing') ||
    m.includes('api key')
  ) {
    return 'env';
  }
  if (m.includes('timeout') || m.includes('exit code') || m.includes('failed')) return 'runtime';
  return 'unknown';
}

function shouldRetryStep(step: string): boolean {
  return step.includes('test:smoke') || step.includes('npm run -s build');
}

function recoveryCommands(
  plan: HostBootstrapPlan,
  category: 'dependency' | 'env' | 'runtime' | 'unknown',
): string[] {
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

export function runHostBootstrapPlan(
  plan: HostBootstrapPlan,
  apply = false,
): HostBootstrapExecution {
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

// ── Interactive wizard ────────────────────────────────────────────────────────

export async function runWizardInteractive(
  defaultProfile: WizardProfile = 'dev-local',
): Promise<WizardResult> {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    // 1. Profile
    const pickedRaw = await rl.question(
      `Profile [${defaultProfile}] (dev-local|prod-shared|prod-decentralized|ollama-local): `,
    );
    const profile = (pickedRaw.trim() || defaultProfile) as WizardProfile;
    if (!['dev-local', 'prod-shared', 'prod-decentralized', 'ollama-local'].includes(profile)) {
      throw new Error(`unknown profile: ${profile}`);
    }

    // 2. Output path
    const outPathRaw = await rl.question('Write .env path [.env]: ');
    const outPath = outPathRaw.trim() || '.env';
    const forceRaw = await rl.question('Overwrite if exists? [y/N]: ');
    const force = ['y', 'yes'].includes(forceRaw.trim().toLowerCase());

    // 3. Generate secrets
    const secrets: WizardSecrets = {
      apiToken: generateSecureToken(),
      vaultPepper: generateSecureToken(),
    };

    // 4. Write .env with generated secrets
    const { path: written } = writeProfileEnv(profile, outPath, force, secrets);

    // 5. Vault setup
    const {
      result: vault,
      passphrase,
      question,
      answer,
    } = await runVaultSetupInteractive(rl, secrets.vaultPepper);

    // 6. Print credential sheet
    process.stdout.write(formatCredentialSheet(secrets, passphrase, question, answer));

    return { profile, written, secrets, vault };
  } finally {
    rl.close();
  }
}
