import { AppError } from '../../../core/errors.js';
import {
  listVaultEntryMetadata,
  readVaultSecretByKey,
  storeVaultSecret,
} from '../../../security/vault-boundary.js';
import { requireOperatorAuth } from '../../auth/operator-gate.js';
import { EXIT_CODES, MemphisExitError } from '../../runtime/exit-codes.js';
import { VaultEntryError, VaultStateError } from '../../storage/rust-vault-adapter.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

const criticalExitCodes = new Set<number>([
  EXIT_CODES.ERR_HARDENING,
  EXIT_CODES.ERR_CORRUPTION,
  EXIT_CODES.ERR_TRUST_ROOT,
]);

function markSecretFailure(error?: unknown): void {
  const current = Number(process.exitCode ?? 0);
  if (criticalExitCodes.has(current)) return;
  let next: number = EXIT_CODES.ERR_GENERAL;
  try {
    if (error instanceof MemphisExitError) {
      const code = Object.getOwnPropertyDescriptor(error, 'exitCode')?.value;
      if (typeof code === 'number' && criticalExitCodes.has(code)) next = code;
    }
  } catch {
    /* Opaque exceptions cannot control the process status. */
  }
  if (next !== EXIT_CODES.ERR_GENERAL || current === 0) process.exitCode = next;
}

function printSecretFailure(
  error: unknown,
  operation: 'write' | 'read' | 'metadata',
  key: string | undefined,
  json: boolean,
): void {
  const defaults = {
    write: { code: 'VAULT_SECRET_WRITE_FAILED', error: 'Vault secret write failed' },
    read: { code: 'VAULT_SECRET_READ_FAILED', error: 'Vault secret read failed' },
    metadata: {
      code: 'VAULT_METADATA_UNAVAILABLE',
      error: 'Vault entry metadata unavailable; run memphis doctor.',
    },
  };
  let failure = defaults[operation];
  try {
    const code =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    if (error instanceof VaultStateError || error instanceof VaultEntryError) {
      const safe =
        error instanceof VaultStateError
          ? new VaultStateError(typeof code === 'string' ? code : '')
          : new VaultEntryError(typeof code === 'string' ? code : '');
      failure = { code: safe.code, error: safe.message };
    } else if (
      error instanceof AppError &&
      (code === 'BRIDGE_UNAVAILABLE' || code === 'BRIDGE_LOAD_FAILURE')
    ) {
      failure = {
        code,
        error: 'Vault bridge unavailable; rebuild the native bridge and run memphis doctor.',
      };
    }
  } catch {
    /* Keep the fixed fallback for hostile exception objects. */
  }
  markSecretFailure(error);
  if (json) print({ ok: false, key, ...failure }, true);
  else console.error(`Error: ${failure.error}`);
}

export const secretCommandHandler: CommandHandler = {
  name: 'secret',
  commands: ['secret'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'secret';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    // S5-1: gate add/get/list before any vault touch. Aligns with
    // GATED_OPERATIONS in operator-gate.ts. Prior to this sweep, the
    // registry promised a passphrase prompt but the handler ran the
    // op silently — a local-host adversary could read or write secret
    // values without the operator passphrase.
    const gatedSubs = new Set(['add', 'get', 'list']);
    if (subcommand && gatedSubs.has(subcommand)) {
      if (!(await requireOperatorAuth())) {
        throw new Error('Operator authentication failed.');
      }
    }
    const handlers: Record<string, () => Promise<boolean>> = {
      add: async () => handleSecretAdd(context),
      get: async () => handleSecretGet(context),
      list: async () => handleSecretList(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.list;
    if (!handler) {
      console.error(`Unknown secret subcommand: ${String(subcommand)}`);
      console.error('Usage: memphis secret <add|get|list>');
      console.error('  add  --key <name> --value <plaintext>   Store an encrypted secret');
      console.error('  get  --key <name>                       Retrieve and decrypt a secret');
      console.error('  list [--key <name>]                     List stored secrets');
      return true;
    }
    // Fall-through to default `list` (no subcommand) also requires auth.
    if (!subcommand && !(await requireOperatorAuth())) {
      throw new Error('Operator authentication failed.');
    }
    return handler();
  },
};

function handleSecretAdd(context: CliContext): boolean {
  const { json, key, value } = context.args;
  if (!key || value === undefined) {
    throw new Error('secret add requires --key <name> and --value <plaintext>');
  }

  try {
    const stored = storeVaultSecret(
      key,
      value,
      { surface: 'cli', command: 'secret add' },
      process.env,
    );
    print({ ok: true, key, fingerprint: stored.fingerprint, createdAt: stored.createdAt }, json);
  } catch (err: unknown) {
    printSecretFailure(err, 'write', key, json);
    return true;
  }
  return true;
}

function handleSecretGet(context: CliContext): boolean {
  const { json, key } = context.args;
  if (!key) throw new Error('secret get requires --key <name>');

  let result: ReturnType<typeof readVaultSecretByKey>;
  try {
    result = readVaultSecretByKey(key, { surface: 'cli', command: 'secret get' }, process.env);
  } catch (error) {
    printSecretFailure(error, 'read', key, json);
    return true;
  }
  if (!result.found) {
    markSecretFailure();
    print({ ok: false, key, error: 'Secret not found', code: 'VAULT_ENTRY_NOT_FOUND' }, json);
    return true;
  }

  if (result.error) {
    markSecretFailure();
    if (json)
      print(
        {
          ok: false,
          key,
          error: result.error,
          code: result.errorCode ?? 'VAULT_SECRET_READ_FAILED',
        },
        true,
      );
    else console.error(`Error decrypting: ${result.error}`);
    return true;
  }

  print({ ok: true, key, value: result.plaintext, createdAt: result.createdAt }, json);
  return true;
}

function handleSecretList(context: CliContext): boolean {
  const { json, key } = context.args;
  let entries: ReturnType<typeof listVaultEntryMetadata>;
  try {
    entries = listVaultEntryMetadata({ surface: 'cli', command: 'secret list' }, process.env, key, {
      latestPerKey: true,
    });
  } catch (error) {
    printSecretFailure(error, 'metadata', key, json);
    return true;
  }

  if (json) {
    print(
      {
        ok: true,
        count: entries.length,
        secrets: entries.map((entry) => ({
          key: entry.key,
          latestAt: entry.createdAt,
          integrityOk: entry.integrityOk,
          fingerprint: entry.fingerprint,
        })),
      },
      true,
    );
  } else {
    if (entries.length === 0) {
      console.log('No secrets stored.');
    } else {
      console.log(`Secrets (${entries.length} key${entries.length > 1 ? 's' : ''}):`);
      for (const entry of entries) {
        console.log(`  ${entry.key} (${entry.createdAt}) integrity=${entry.integrityOk}`);
      }
    }
  }
  return true;
}
