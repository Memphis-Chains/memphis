#!/usr/bin/env node
/**
 * Vault recovery helper — initialize vault state when `memphis init` skips
 * vault setup because of a stale legacy first-run record.
 *
 * Use case: after the 2026-04-25 silent-reinit incident, the corrupt
 * vault-state.json + vault-entries.json were moved aside (forensic preserve).
 * `memphis init` then refused to create a new vault because first-run.json
 * already existed and routed through the legacy-adoption code path,
 * leaving the daemon without a usable vault. This script bypasses that
 * decision tree and calls `initializeVault` directly with operator-supplied
 * credentials, then exits.
 *
 * Run from the repo root:
 *   node scripts/recover-vault-init.mjs
 *
 * Prompts (hidden TTY for secrets):
 *   - vault passphrase (≥8 chars)
 *   - confirm passphrase
 *   - recovery question (visible, ≥3 chars)
 *   - recovery answer (hidden, ≥1 char)
 *
 * On success: data/vault-state.json + data/vault-entries.json are written.
 * Then `memphis vault add` for each secret, then `systemctl --user start memphis`.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import promptsModule from 'prompts';

const prompts = promptsModule.default ?? promptsModule;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = pathToFileURL(resolve(ROOT, 'dist', 'security', 'vault-boundary.js')).href;

/**
 * Load .env into process.env without overwriting variables the operator
 * already set in the shell. Mirrors the daemon's EnvironmentFile=...
 * loader so the recovery script sees the same MEMPHIS_VAULT_PEPPER /
 * RUST_CHAIN_BRIDGE_PATH the daemon uses — without those, vaultInit can
 * succeed in Rust but persistVaultState writes a v1 fallback that the
 * daemon then refuses to load.
 */
function loadDotEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function onCancel() {
  console.error('Cancelled.');
  process.exit(130);
}

async function main() {
  console.log('── Vault recovery (fresh init) ─────────────────────────');
  console.log('Creates a new vault-state.json + vault-entries.json.');
  console.log('Refuses if state already exists (set MEMPHIS_VAULT_FORCE_REINIT=1');
  console.log('to override — DESTRUCTIVE).');
  console.log('');

  const answers = await prompts(
    [
      {
        type: 'password',
        name: 'passphrase',
        message: 'New vault passphrase (≥8 chars)',
        validate: (v) => (v && v.length >= 8 ? true : 'must be at least 8 characters'),
      },
      {
        type: 'password',
        name: 'confirm',
        message: 'Confirm passphrase',
      },
      {
        type: 'text',
        name: 'recoveryQuestion',
        message: 'Recovery question (≥3 chars)',
        validate: (v) => (v && v.trim().length >= 3 ? true : 'must be at least 3 characters'),
      },
      {
        type: 'password',
        name: 'recoveryAnswer',
        message: 'Recovery answer',
        validate: (v) => (v && v.length >= 1 ? true : 'must not be empty'),
      },
    ],
    { onCancel },
  );

  if (answers.passphrase !== answers.confirm) {
    console.error('ERROR: passphrase confirmation mismatch');
    process.exit(1);
  }

  const { initializeVault, probeVaultCipherCycle } = await import(DIST);

  let result;
  try {
    result = initializeVault(
      {
        passphrase: answers.passphrase,
        recovery_question: answers.recoveryQuestion.trim(),
        recovery_answer: answers.recoveryAnswer,
      },
      { surface: 'cli', command: 'recover-vault-init' },
      process.env,
    );
  } catch (err) {
    console.error('');
    console.error('Vault init failed:', err?.message ?? err);
    process.exit(1);
  }

  console.log('');
  console.log('✓ Vault initialized.');
  console.log('  did:', result?.did ?? '(unknown)');
  console.log('  version:', result?.version ?? '(unknown)');

  const probe = probeVaultCipherCycle(
    { surface: 'cli', command: 'recover-vault-init' },
    process.env,
  );
  if (!probe.ok) {
    console.error('');
    console.error('WARNING: cipher cycle probe failed:', probe.error);
    process.exit(1);
  }
  console.log('✓ Encrypt/decrypt cycle verified.');
  console.log('');
  console.log('Next steps:');
  console.log(`  1. CD to the repo (vault paths in .env are relative to cwd):`);
  console.log(`       cd ${ROOT}`);
  console.log('  2. Add your secrets:');
  console.log('       memphis vault add --key minimax_api_key');
  console.log('       memphis vault add --key telegram_bot_token');
  console.log('       memphis vault add --key telegram_allowed_user_ids');
  console.log('  3. Start the daemon:');
  console.log('       systemctl --user start memphis');
  console.log('  4. Verify health:');
  console.log("       curl -s http://127.0.0.1:3100/health | python3 -c \"import json,sys;h=json.loads(sys.stdin.read());print(h['status'])\"");
  console.log('');
  console.log('NOTE: every `memphis vault ...` MUST run with cwd = repo root.');
  console.log('If you see "Vault secret write failed" you are in the wrong directory.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
