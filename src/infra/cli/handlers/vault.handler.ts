import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

import type { CommandHandler } from './command-handler.js';
import { getDataDir } from '../../../config/paths.js';
import {
  recoverOperatorPassphrase,
  requireOperatorAuth,
} from '../../../infra/auth/operator-gate.js';
import {
  initializeVault,
  listVaultEntryMetadata,
  readVaultSecretByKey,
  storeVaultSecret,
  toVaultEntryMetadata,
} from '../../../security/vault-boundary.js';
import { findVaultKeyReferences, upsertEnvVars } from '../../config/env-file.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';
import { resolveInstallRoot } from '../../runtime/install-root.js';
import { rotateVaultMasterKey, rotateVaultStatePepper } from '../../storage/rust-vault-adapter.js';
import { deleteVaultEntriesByKey, listVaultEntries } from '../../storage/vault-entry-store.js';
import { resolveVaultPath } from '../../storage/vault-paths.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

async function promptHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    throw new Error(
      `Cannot prompt for ${label}: stdin is not a TTY. Pass --passphrase / --recovery-question / --recovery-answer flags instead.`,
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

async function promptVisible(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = await rl.question(`${label}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

export const vaultCommandHandler: CommandHandler = {
  name: 'vault',
  commands: ['vault'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'vault';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      init: () => handleVaultInit(context),
      add: () => handleVaultAdd(context),
      get: async () => handleVaultGet(context),
      list: async () => handleVaultList(context),
      reset: async () => handleVaultReset(context),
      'pepper-rotate': () => handleVaultPepperRotate(context),
      'entry-delete': async () => handleVaultEntryDelete(context),
      'master-key-rotate': async () => handleVaultMasterKeyRotate(context),
      'recovery-unlock': () => handleVaultRecoveryUnlock(context),
      migrate: async () => handleVaultMigrate(context),
    };
    const handler = subcommand ? handlers[subcommand] : undefined;
    if (!handler) throw new Error(`Unknown vault subcommand: ${String(subcommand)}`);
    return handler();
  },
};

async function handleVaultInit(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  let { passphrase, recoveryAnswer, recoveryQuestion } = context.args;

  const anyFlagProvided = Boolean(passphrase || recoveryQuestion || recoveryAnswer);
  const allFlagsProvided = Boolean(passphrase && recoveryQuestion && recoveryAnswer);

  if (anyFlagProvided && !allFlagsProvided) {
    throw new Error(
      'vault init: pass ALL of --passphrase --recovery-question --recovery-answer, or pass NONE to enter them interactively.',
    );
  }

  if (!allFlagsProvided) {
    if (json) {
      throw new Error(
        'vault init --json requires --passphrase --recovery-question --recovery-answer (no prompts in JSON mode).',
      );
    }
    process.stdout.write('── Vault initialization ──────────────────────────────\n');
    process.stdout.write('Creates the encrypted vault that holds provider API keys.\n');
    process.stdout.write('This passphrase is SEPARATE from your operator passphrase\n');
    process.stdout.write('(which gates destructive CLI ops). You can set that up later\n');
    process.stdout.write('with: memphis operator set-passphrase\n\n');

    passphrase = await promptHidden('Vault passphrase (min 8 chars)');
    if (passphrase.length < 8) {
      throw new Error('Vault passphrase must be at least 8 characters.');
    }
    const confirmPass = await promptHidden('Confirm vault passphrase');
    if (confirmPass !== passphrase) {
      throw new Error('Vault passphrases do not match.');
    }
    recoveryQuestion = await promptVisible('Recovery question (e.g. "First pet\'s name?")');
    if (!recoveryQuestion) {
      throw new Error('Recovery question cannot be empty.');
    }
    recoveryAnswer = await promptHidden('Recovery answer');
    if (!recoveryAnswer) {
      throw new Error('Recovery answer cannot be empty.');
    }
  }

  const vault = initializeVault(
    {
      passphrase: passphrase!,
      recovery_question: recoveryQuestion!,
      recovery_answer: recoveryAnswer!,
    },
    { surface: 'cli', command: 'vault init' },
    process.env,
  );

  print({ ok: true, vault }, json);
  return true;
}

async function handleVaultAdd(context: CliContext): Promise<boolean> {
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  const { json } = context.args;
  let { value } = context.args;

  // Accept the key either as `--key <name>` or as a positional argument
  // (`memphis vault add <name>`). Operator's natural shape is the
  // positional form — same UX gap that PR #307 fixed for `memphis ask`,
  // applied here to the vault handler.
  const key = context.args.key ?? context.args.target;

  if (!key) {
    throw new Error(
      'vault add requires a key name. Pass it as `memphis vault add <name>` or `memphis vault add --key <name>`.',
    );
  }

  if (value === undefined) {
    if (json) {
      throw new Error(
        'vault add --json requires --value (no prompts in JSON mode). Omit --json to enter the secret interactively.',
      );
    }
    if (!process.stdin.isTTY) {
      throw new Error(
        'vault add: stdin is not a TTY. Run from an interactive shell so the secret can be prompted privately, or redirect stdin through a TTY.',
      );
    }
    process.stdout.write(`── Vault add ────────────────────────────────────────\n`);
    process.stdout.write(`Stores an encrypted secret under key "${key}" in the vault.\n`);
    process.stdout.write('The secret is prompted here instead of being passed on the\n');
    process.stdout.write('command line so it does not appear in your shell history.\n\n');
    value = await promptHidden(`Secret value for ${key}`);
    if (!value) throw new Error('Vault secret cannot be empty.');
  }

  const stored = storeVaultSecret(
    key,
    value,
    { surface: 'cli', command: 'vault add' },
    process.env,
  );

  // Auto-enable provider env var for recognized slots. The provider
  // registry at src/providers/runtime-registry.ts gates vault lookup
  // on `<PROVIDER>_VAULT_KEY` env vars. Without this step, an operator
  // who ran `memphis vault add --key anthropic_api_key …` would still
  // see `[down] ANTHROPIC_API_KEY not set` in the TUI status pill —
  // the vault entry existed but the registry had no instruction to
  // look it up. Observed on operator WSL 2026-04-20.
  const envVar = PROVIDER_VAULT_ENV_MAP[key];
  let autoEnabledEnv: string | undefined;
  if (envVar) {
    upsertEnvVars([{ key: envVar, value: key }]);
    autoEnabledEnv = envVar;
  }

  print(
    {
      ok: true,
      entry: toVaultEntryMetadata(stored),
      ...(autoEnabledEnv
        ? { autoEnabled: { envVar: autoEnabledEnv, hint: 'Restart the service to pick up the new provider configuration.' } }
        : {}),
    },
    json,
  );

  if (autoEnabledEnv && !json) {
    process.stdout.write(
      `\nnote: auto-enabled ${autoEnabledEnv}=${key} in .env — restart the service to pick up the provider.\n`,
    );
  }
  return true;
}

/**
 * Vault-key → provider-registry env var. Keys here mirror the
 * VAULT_KEY_MAP table in src/providers/runtime-registry.ts. When an
 * operator stores a secret under one of these names, auto-enable the
 * corresponding env var so the provider becomes usable on next
 * restart without manual .env edits.
 */
const PROVIDER_VAULT_ENV_MAP: Record<string, string> = {
  anthropic_api_key: 'ANTHROPIC_VAULT_KEY',
  // NOTE: `anthropic_oauth_refresh_token` deliberately absent. The old
  // entry pointed it at `ANTHROPIC_VAULT_KEY` — the same slot the API
  // key uses — so `memphis vault add --key anthropic_oauth_refresh_token`
  // would silently overwrite the operator's API key reference, breaking
  // a working Anthropic setup on next service restart. The refresh
  // token has no runtime resolver anyway (VAULT_KEY_MAP in
  // `src/providers/index.ts` only maps `anthropic_api_key` +
  // `anthropic_oauth_secret` to providers). Dropped per Codex H3.
  anthropic_oauth_client_secret: 'ANTHROPIC_OAUTH_SECRET_VAULT_KEY',
  minimax_api_key: 'MINIMAX_VAULT_KEY',
  deepseek_api_key: 'DEEPSEEK_VAULT_KEY',
  glm_api_key: 'GLM_VAULT_KEY',
};

async function handleVaultGet(context: CliContext): Promise<boolean> {
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  const { json } = context.args;
  // Accept --key <name> or positional `vault get <name>`.
  const key = context.args.key ?? context.args.target;
  if (!key) {
    throw new Error('vault get requires a key: `memphis vault get <name>` or `--key <name>`.');
  }
  const result = readVaultSecretByKey(key, { surface: 'cli', command: 'vault get' }, process.env);
  if (!result.found) throw new Error(`vault key not found: ${key}`);
  if (result.error) throw new Error(result.error);
  print({ ok: true, key, value: result.plaintext }, json);
  return true;
}

async function handleVaultList(context: CliContext): Promise<boolean> {
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  print(
    {
      ok: true,
      entries: listVaultEntryMetadata(
        { surface: 'cli', command: 'vault list' },
        process.env,
        context.args.key,
      ),
    },
    context.args.json,
  );
  return true;
}

async function handleVaultEntryDelete(context: CliContext): Promise<boolean> {
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  const { json, force, confirm } = context.args;
  // Accept --key <name> or positional `vault entry-delete <name>`.
  const key = context.args.key ?? context.args.target;

  if (!key) {
    throw new Error(
      'vault entry-delete requires a key: `memphis vault entry-delete <name>` or `--key <name>`.',
    );
  }
  if (!confirm) {
    throw new Error(
      `vault entry-delete requires --confirm. This permanently removes every entry with key="${key}" from data/vault-entries.json.`,
    );
  }

  const existing = listVaultEntries(process.env, key);
  if (existing.length === 0) {
    throw new Error(`No vault entries found with key "${key}". Nothing to delete.`);
  }

  const references = findVaultKeyReferences(key);
  if (references.length > 0 && !force) {
    const refsSummary = references
      .map((r) => `  ${r.envKey}=${r.envValue} (${r.style})`)
      .join('\n');
    throw new Error(
      `Refusing to delete vault entries for "${key}" — .env still references it:\n${refsSummary}\n` +
        `Remove the references from .env first, or pass --force to delete anyway (the referenced provider will then fail to load).`,
    );
  }

  const result = deleteVaultEntriesByKey(key, process.env);

  writeSecurityAudit({
    action: 'vault.secret-delete',
    status: 'allowed',
    details: {
      surface: 'cli',
      command: 'vault entry-delete',
      key,
      removedCount: result.removedCount,
      remainingCount: result.remainingCount,
      forceUsed: Boolean(force),
      orphanedEnvRefs: references.map((r) => r.envKey),
    },
  });

  print(
    {
      ok: true,
      key,
      removedCount: result.removedCount,
      remainingCount: result.remainingCount,
      path: result.path,
      orphanedEnvRefs: references.map((r) => r.envKey),
      nextSteps:
        references.length > 0
          ? [
              '# Orphaned .env references remain — the referenced providers will fail at runtime:',
              ...references.map((r) => `  unset ${r.envKey} (or edit .env)`),
            ]
          : ['memphis vault list && memphis doctor'],
    },
    json,
  );
  return true;
}

async function handleVaultPepperRotate(context: CliContext): Promise<boolean> {
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  const { json } = context.args;

  if (!context.args.confirm) {
    throw new Error(
      'vault pepper-rotate requires --confirm. This rewraps the master key under a new pepper ' +
        'and rewrites data/vault-state.json + .env atomically. If you lose the NEW pepper before ' +
        'you back it up off-host, the vault is unrecoverable.',
    );
  }

  if (json) {
    throw new Error(
      'vault pepper-rotate is interactive only; --json is not supported because secrets are prompted.',
    );
  }

  process.stdout.write('── Vault pepper rotation ─────────────────────────────\n');
  process.stdout.write('This rewraps the vault master key under a NEW pepper.\n');
  process.stdout.write('The master key and all entries stay the same — only the\n');
  process.stdout.write('outer wrapper changes. Lose the new pepper without backup\n');
  process.stdout.write('= vault unrecoverable. Back it up off-host first.\n\n');

  const envOldPepper = (process.env.MEMPHIS_VAULT_PEPPER ?? '').trim();
  let oldPepper = envOldPepper;
  if (!oldPepper) {
    oldPepper = await promptHidden('Current pepper');
  } else {
    process.stdout.write('Using current MEMPHIS_VAULT_PEPPER from env for OLD pepper.\n');
  }

  const newPepper = await promptHidden('New pepper (min 12 chars)');
  if (newPepper.length < 12) {
    throw new Error('New pepper must be at least 12 characters.');
  }
  if (newPepper === oldPepper) {
    throw new Error('New pepper must differ from old pepper.');
  }
  const confirmPepper = await promptHidden('Confirm new pepper');
  if (confirmPepper !== newPepper) {
    throw new Error('New pepper confirmation does not match.');
  }

  // Rotate state first so the re-encrypted vault-state.json is on disk,
  // then update .env. If the .env write fails (permissions, disk full,
  // concurrent write), we attempt a reverse rotation to restore the state
  // file to oldPepper — leaving operator disk in the pre-rotation shape
  // rather than a state/.env desync that would break vault reads on next
  // startup. Best-effort: if the reverse rotation itself also fails, we
  // surface a loud structured error that names both mismatched halves.
  let result: ReturnType<typeof rotateVaultStatePepper> | undefined;
  try {
    result = rotateVaultStatePepper(oldPepper, newPepper, process.env);
  } catch (err) {
    writeSecurityAudit({
      action: 'vault.pepper-rotate',
      status: 'error',
      details: {
        surface: 'cli',
        command: 'vault pepper-rotate',
        stage: 'rotate-state',
        reason: err instanceof Error ? err.message : 'unknown_error',
      },
    });
    throw err;
  }

  try {
    const envUpdate = upsertEnvVars([{ key: 'MEMPHIS_VAULT_PEPPER', value: newPepper }]);
    process.env.MEMPHIS_VAULT_PEPPER = newPepper;

    writeSecurityAudit({
      action: 'vault.pepper-rotate',
      status: 'allowed',
      details: {
        surface: 'cli',
        command: 'vault pepper-rotate',
        statePath: result.statePath,
        envPath: envUpdate.path,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
      },
    });

    print(
      {
        ok: true,
        statePath: result.statePath,
        envPath: envUpdate.path,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        nextSteps: [
          '# The .env file now holds the NEW pepper. Back it up off-host IMMEDIATELY:',
          `grep '^MEMPHIS_VAULT_PEPPER=' ${envUpdate.path}`,
          '# Verify the vault still reads:',
          'memphis vault list',
        ],
      },
      false,
    );
    return true;
  } catch (err) {
    const envMessage = err instanceof Error ? err.message : 'unknown_error';
    // .env write failed after state rotation succeeded. Try to reverse the
    // rotation so disk state matches the (unchanged) operator .env file.
    let rollbackOk = false;
    let rollbackError: string | null = null;
    try {
      rotateVaultStatePepper(newPepper, oldPepper, process.env);
      rollbackOk = true;
    } catch (rollbackErr) {
      rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    }

    writeSecurityAudit({
      action: 'vault.pepper-rotate',
      status: 'error',
      details: {
        surface: 'cli',
        command: 'vault pepper-rotate',
        stage: 'update-env',
        reason: envMessage,
        rollback: rollbackOk ? 'reverted-state-to-old-pepper' : 'rollback-failed',
        rollbackError,
        statePath: result.statePath,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
      },
    });

    if (rollbackOk) {
      throw new Error(
        `vault pepper-rotate failed at .env write (${envMessage}). State file was ` +
          `reverted to the OLD pepper — vault remains readable with the current ` +
          `MEMPHIS_VAULT_PEPPER. Fix the .env permission/disk issue and retry.`,
      );
    }
    throw new Error(
      `vault pepper-rotate FAILED CATASTROPHICALLY: .env write failed ` +
        `(${envMessage}) AND rollback of the rotated state also failed (${rollbackError}). ` +
        `vault-state.json is now encrypted with the NEW pepper but .env still ` +
        `holds the OLD pepper. Manually set MEMPHIS_VAULT_PEPPER=<new-pepper> in ` +
        `${result.statePath ? `${result.statePath.replace(/vault-state\.json$/, '.env')}` : '.env'} ` +
        `or restore data/vault-state.json from a backup before the next start.`,
    );
  }
}

async function handleVaultRecoveryUnlock(context: CliContext): Promise<boolean> {
  const { json } = context.args;

  if (json) {
    throw new Error(
      'vault recovery-unlock is interactive only; --json is not supported because the recovery answer is prompted.',
    );
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'vault recovery-unlock requires an interactive TTY so the recovery answer can be prompted privately.',
    );
  }

  process.stdout.write('── Vault recovery unlock ─────────────────────────────\n');
  process.stdout.write('Uses the recovery Q/A stored at `memphis vault init` to\n');
  process.stdout.write('reset the OPERATOR passphrase (the sudo-like gate that\n');
  process.stdout.write('authorizes destructive CLI ops). This does NOT recover\n');
  process.stdout.write('a lost MEMPHIS_VAULT_PEPPER — if you lost that, the vault\n');
  process.stdout.write('entries are unrecoverable. After this unlock, you can run\n');
  process.stdout.write('  memphis vault pepper-rotate --confirm\n');
  process.stdout.write('to rewrap the state under a fresh pepper if desired.\n\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    const result = await recoverOperatorPassphrase(rl);
    if (!result.ok) {
      writeSecurityAudit({
        action: 'vault.recovery-unlock',
        status: 'error',
        details: {
          surface: 'cli',
          command: 'vault recovery-unlock',
          reason: result.error ?? 'unknown_error',
        },
      });
      throw new Error(result.error ?? 'Recovery failed.');
    }
    writeSecurityAudit({
      action: 'vault.recovery-unlock',
      status: 'allowed',
      details: { surface: 'cli', command: 'vault recovery-unlock' },
    });
    print(
      {
        ok: true,
        message: 'Operator passphrase reset via recovery answer. Session authorized.',
        nextSteps: [
          '# (Optional) Rewrap vault state under a new pepper:',
          'memphis vault pepper-rotate --confirm',
          '# Verify vault still reads:',
          'memphis vault list',
        ],
      },
      false,
    );
    return true;
  } finally {
    rl.close();
  }
}

async function handleVaultMasterKeyRotate(context: CliContext): Promise<boolean> {
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  const { json, confirm } = context.args;

  if (!confirm) {
    throw new Error(
      'vault master-key-rotate requires --confirm. This re-encrypts every vault entry under a fresh master key ' +
        'and atomically swaps vault-state.json + vault-entries.json. Any entry that fails to decrypt under the ' +
        'current master key will abort the operation (delete those first via "memphis vault entry-delete").',
    );
  }

  try {
    const result = rotateVaultMasterKey(process.env);
    writeSecurityAudit({
      action: 'vault.master-key-rotate',
      status: 'allowed',
      details: {
        surface: 'cli',
        command: 'vault master-key-rotate',
        statePath: result.statePath,
        entriesPath: result.entriesPath,
        rotatedCount: result.rotatedCount,
      },
    });

    print(
      {
        ok: true,
        statePath: result.statePath,
        entriesPath: result.entriesPath,
        rotatedCount: result.rotatedCount,
        nextSteps: [
          '# Master key rotated. Every entry has been re-encrypted under the new key.',
          '# Verify the vault still reads:',
          'memphis vault list',
          '# If you keep off-host backups of vault-state.json, replace them with the new file.',
        ],
      },
      json,
    );
    return true;
  } catch (err) {
    writeSecurityAudit({
      action: 'vault.master-key-rotate',
      status: 'error',
      details: {
        surface: 'cli',
        command: 'vault master-key-rotate',
        reason: err instanceof Error ? err.message : 'unknown_error',
      },
    });
    throw err;
  }
}

/**
 * Move legacy `${installRoot}/data/vault-{state,entries}.json` files into the
 * new home (`${MEMPHIS_HOME ?? ~/.memphis}/`).
 *
 * The 2026-04-25 silent re-init incident traced back to relative `./data/...`
 * paths sharing the same vault between the daemon and any one-shot script
 * launched from the repo root. PR #279 introduced absolute MEMPHIS_HOME paths
 * with a deprecation warning when legacy files are detected. This subcommand
 * is the operator-facing migration step.
 *
 * Behaviour:
 *   - Detects legacy + new locations for both vault-state.json and
 *     vault-entries.json
 *   - If neither file exists in the legacy location → nothing to do
 *   - If a new-location file already exists alongside a legacy one → refuses
 *     (would clobber active state). Operator must resolve manually.
 *   - Otherwise renames each file (atomic rename, falls back to copy+unlink
 *     when crossing filesystems) and reports the result.
 *   - Requires `--yes` for non-interactive confirmation, or prompts on TTY.
 *
 * Audit: every move emits a `vault-migrate` audit row.
 */
async function handleVaultMigrate(context: CliContext): Promise<boolean> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const readline = await import('node:readline/promises');

  const rawEnv = process.env as NodeJS.ProcessEnv;
  const newDir = getDataDir(rawEnv);
  let installRoot: string | null = null;
  try {
    installRoot = resolveInstallRoot({ rawEnv });
  } catch {
    // ignore — handled below
  }
  if (!installRoot) {
    console.error(
      'vault migrate: could not discover install root; nothing to migrate.\n' +
        'If your legacy vault lives somewhere unusual, set MEMPHIS_VAULT_STATE_PATH and ' +
        'MEMPHIS_VAULT_ENTRIES_PATH instead and skip the migrate step.',
    );
    return true;
  }

  const files = ['vault-state.json', 'vault-entries.json'] as const;
  const plan = await Promise.all(
    files.map(async (file) => {
      const legacy = path.join(installRoot, 'data', file);
      const target = path.join(newDir, file);
      const legacyExists = await fs
        .access(legacy)
        .then(() => true)
        .catch(() => false);
      const targetExists = await fs
        .access(target)
        .then(() => true)
        .catch(() => false);
      return { file, legacy, target, legacyExists, targetExists };
    }),
  );

  const moves = plan.filter((p) => p.legacyExists);
  if (moves.length === 0) {
    if (context.args.json) {
      console.log(JSON.stringify({ ok: true, migrated: 0, reason: 'no-legacy-vault' }, null, 2));
    } else {
      console.log(`No legacy vault files at ${path.join(installRoot, 'data')} — nothing to migrate.`);
      console.log(`Active vault location: ${newDir}`);
    }
    return true;
  }

  const conflicts = moves.filter((p) => p.targetExists);
  if (conflicts.length > 0) {
    console.error('vault migrate refusing to clobber existing files:');
    for (const c of conflicts) {
      console.error(`  ${c.file}: legacy=${c.legacy} target=${c.target} (target exists)`);
    }
    console.error(
      '\nIf the new location is the active vault, delete the legacy files manually.\n' +
        'If the legacy location is the active vault, set MEMPHIS_VAULT_*_PATH to point to it.',
    );
    // Codex P2 fix on PR #289: scripts that wrap `vault migrate` need
    // a non-zero exit code to know the operation was refused. `return
    // true` is "I handled it" — the failure signal goes through
    // process.exitCode, mirroring the configure-retired pattern.
    process.exitCode = 1;
    return true;
  }

  const yes = context.argv.includes('--yes');
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error('vault migrate requires --yes when stdin is not a TTY.');
      process.exitCode = 1;
      return true;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('vault migrate plan:');
      for (const m of moves) {
        console.log(`  move ${m.legacy}`);
        console.log(`    → ${m.target}`);
      }
      const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return true;
      }
    } finally {
      rl.close();
    }
  }

  await fs.mkdir(newDir, { recursive: true });
  const moved: string[] = [];
  for (const m of moves) {
    try {
      await fs.rename(m.legacy, m.target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EXDEV') {
        // Cross-filesystem rename → fall back to copy+unlink.
        await fs.copyFile(m.legacy, m.target);
        await fs.unlink(m.legacy);
      } else {
        throw error;
      }
    }
    moved.push(m.file);
    try {
      writeSecurityAudit({
        action: 'vault-migrate',
        status: 'allowed',
        details: { actor: 'cli', file: m.file, legacy: m.legacy, target: m.target },
      });
    } catch {
      /* audit best-effort */
    }
  }

  if (context.args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          migrated: moved.length,
          files: moved,
          legacyDir: path.join(installRoot, 'data'),
          targetDir: newDir,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Migrated ${moved.length} vault file${moved.length === 1 ? '' : 's'}:`);
    for (const file of moved) {
      console.log(`  ${file}`);
    }
    console.log(`From: ${path.join(installRoot, 'data')}`);
    console.log(`To:   ${newDir}`);
  }
  return true;
}

async function handleVaultReset(context: CliContext): Promise<boolean> {
  // vault reset moves live vault files aside — same destructive shape as
  // pepper-rotate, master-key-rotate, and entry-delete, so gate it behind
  // the same operator passphrase. Without this, anyone with shell access
  // can wipe the active vault state/entries with `memphis vault reset
  // --confirm`, making this a CLI privilege bypass.
  if (!(await requireOperatorAuth())) throw new Error('Operator authentication failed.');
  if (!context.args.confirm) {
    throw new Error(
      'vault reset requires --confirm; this moves vault-state.json and vault-entries.json into a timestamped backup dir. Run `memphis vault init` afterwards to create a fresh vault.',
    );
  }

  const rawEnv = process.env;
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  const entriesPath = resolveVaultPath('vault-entries.json', rawEnv);
  const stateExists = existsSync(statePath);
  const entriesExist = existsSync(entriesPath);

  if (!stateExists && !entriesExist) {
    writeSecurityAudit({
      action: 'vault.reset',
      status: 'allowed',
      details: { surface: 'cli', command: 'vault reset', reason: 'no_files_present' },
    });
    print(
      { ok: true, reset: false, message: 'No vault files present; nothing to reset.' },
      context.args.json,
    );
    return true;
  }

  const ts = Math.floor(Date.now() / 1000);
  const backupDir = join(dirname(statePath), `vault-bak-${ts}`);
  mkdirSync(backupDir, { recursive: true });

  const moved: Array<{ from: string; to: string }> = [];
  if (stateExists) {
    const dest = join(backupDir, 'vault-state.json');
    renameSync(statePath, dest);
    moved.push({ from: statePath, to: dest });
  }
  if (entriesExist) {
    const dest = join(backupDir, 'vault-entries.json');
    renameSync(entriesPath, dest);
    moved.push({ from: entriesPath, to: dest });
  }

  writeSecurityAudit({
    action: 'vault.reset',
    status: 'allowed',
    details: {
      surface: 'cli',
      command: 'vault reset',
      backupDir,
      movedCount: moved.length,
      moved,
    },
  });

  print(
    {
      ok: true,
      reset: true,
      backupDir,
      moved,
      nextSteps: [
        '# 1. Re-create the vault (prompts interactively — no secrets on the command line):',
        'memphis vault init',
        '# 2. (Optional) Set the operator passphrase — SEPARATE from the vault passphrase,',
        '#    used as a sudo-like gate for destructive CLI ops:',
        'memphis operator set-passphrase',
        '# 3. Add providers:',
        'memphis auth anthropic                         # OAuth (recommended)',
        'memphis provider add minimax --api-key <key>   # or any other provider',
        '# 4. Verify:',
        'memphis vault list && memphis doctor',
      ],
    },
    context.args.json,
  );
  return true;
}
