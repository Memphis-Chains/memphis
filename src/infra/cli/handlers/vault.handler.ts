import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

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
import { rotateVaultMasterKey, rotateVaultStatePepper } from '../../storage/rust-vault-adapter.js';
import { deleteVaultEntriesByKey, listVaultEntries } from '../../storage/vault-entry-store.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

function resolveVaultStatePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolve(rawEnv.MEMPHIS_VAULT_STATE_PATH ?? './data/vault-state.json');
}

function resolveVaultEntriesPath(rawEnv: NodeJS.ProcessEnv): string {
  return resolve(rawEnv.MEMPHIS_VAULT_ENTRIES_PATH ?? './data/vault-entries.json');
}

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
      add: async () => handleVaultAdd(context),
      get: async () => handleVaultGet(context),
      list: async () => handleVaultList(context),
      reset: async () => handleVaultReset(context),
      'pepper-rotate': () => handleVaultPepperRotate(context),
      'entry-delete': async () => handleVaultEntryDelete(context),
      'master-key-rotate': async () => handleVaultMasterKeyRotate(context),
      'recovery-unlock': () => handleVaultRecoveryUnlock(context),
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

function handleVaultAdd(context: CliContext): boolean {
  requireOperatorAuth();
  const { json, key, value } = context.args;
  if (!key || value === undefined) throw new Error('vault add requires --key and --value');
  const stored = storeVaultSecret(key, value, { surface: 'cli', command: 'vault add' }, process.env);
  print({ ok: true, entry: toVaultEntryMetadata(stored) }, json);
  return true;
}

function handleVaultGet(context: CliContext): boolean {
  requireOperatorAuth();
  const { json, key } = context.args;
  if (!key) throw new Error('vault get requires --key');
  const result = readVaultSecretByKey(key, { surface: 'cli', command: 'vault get' }, process.env);
  if (!result.found) throw new Error(`vault key not found: ${key}`);
  if (result.error) throw new Error(result.error);
  print({ ok: true, key, value: result.plaintext }, json);
  return true;
}

function handleVaultList(context: CliContext): boolean {
  requireOperatorAuth();
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

function handleVaultEntryDelete(context: CliContext): boolean {
  requireOperatorAuth();
  const { json, key, force, confirm } = context.args;

  if (!key) {
    throw new Error('vault entry-delete requires --key <name>');
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
  requireOperatorAuth();
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

  try {
    const result = rotateVaultStatePepper(oldPepper, newPepper, process.env);
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
    writeSecurityAudit({
      action: 'vault.pepper-rotate',
      status: 'error',
      details: {
        surface: 'cli',
        command: 'vault pepper-rotate',
        reason: err instanceof Error ? err.message : 'unknown_error',
      },
    });
    throw err;
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

function handleVaultMasterKeyRotate(context: CliContext): boolean {
  requireOperatorAuth();
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

function handleVaultReset(context: CliContext): boolean {
  if (!context.args.confirm) {
    throw new Error(
      'vault reset requires --confirm; this moves vault-state.json and vault-entries.json into a timestamped backup dir. Run `memphis vault init` afterwards to create a fresh vault.',
    );
  }

  const rawEnv = process.env;
  const statePath = resolveVaultStatePath(rawEnv);
  const entriesPath = resolveVaultEntriesPath(rawEnv);
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
