/**
 * `memphis brave` CLI — dedicated UX for adding/checking the
 * Brave Search API key.
 *
 * Mirrors the pattern of `memphis telegram configure` (vault-store +
 * .env upsert + status probe). Stores the key under vault entry
 * `brave_api_key` and writes the .env reference `BRAVE_API_KEY=
 * VAULT:brave_api_key`. On success, journals a config-change event
 * (`tags: ['config-change', 'brave-search']`) so the bot's chain_hits
 * picks up "BRAVE_API_KEY was just configured" the next time the
 * operator asks about external APIs / capabilities.
 *
 * Subcommands:
 *   - `configure --key <token>`  — store + activate
 *   - `status`                   — show key presence + API health probe
 */

import chalk from 'chalk';

import type { CommandHandler } from './command-handler.js';
import { runMemphisBraveSearch } from '../../../mcp/tools/brave-search.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { storeVaultSecret } from '../../../security/vault-boundary.js';
import { upsertEnvVars } from '../../config/env-file.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

const VAULT_KEY = 'brave_api_key';

export const braveCommandHandler: CommandHandler = {
  name: 'brave',
  commands: ['brave'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'brave';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      configure: () => handleBraveConfigure(context),
      status: () => handleBraveStatus(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.status;
    if (!handler) {
      throw new Error(
        `Unknown subcommand: memphis brave ${subcommand}. Try: configure | status`,
      );
    }
    return handler();
  },
};

async function handleBraveConfigure(context: CliContext): Promise<boolean> {
  const { json, key } = context.args as { json?: boolean; key?: string };

  if (!key || key.trim().length === 0) {
    throw new Error(
      'memphis brave configure --key <token> required. Get a key (free 2000 q/mo) at https://api.search.brave.com/.',
    );
  }

  const trimmed = key.trim();
  // Brave keys begin with "BSA" and are ~32+ chars. Don't hard-fail on
  // shape mismatch — Brave doesn't publish a stable format guarantee
  // — just warn so the operator catches obvious paste errors.
  const looksValid = /^BSA[A-Za-z0-9_-]{20,}$/.test(trimmed);
  const warnings: string[] = [];
  if (!looksValid) {
    warnings.push(
      'Key does not match the typical "BSA..." Brave format. Continuing — verify with `memphis brave status`.',
    );
  }

  // Store in vault
  storeVaultSecret(
    VAULT_KEY,
    trimmed,
    { surface: 'cli', command: 'brave configure' },
    process.env,
  );

  // Upsert .env so subsequent restarts pick up the vault reference.
  // Using upsertEnvVars (idempotent — replaces existing line) so a
  // re-run of `memphis brave configure` updates the key without
  // duplicating the env entry.
  const envUpdate = upsertEnvVars([{ key: 'BRAVE_API_KEY', value: `VAULT:${VAULT_KEY}` }]);

  // Make the new key visible to the current process so the journal
  // event below + the status probe see the resolved value, not the
  // pre-configure state.
  process.env.BRAVE_API_KEY = trimmed;

  // Journal a config-change event so the bot's cognitive prelude
  // picks up "BRAVE_API_KEY was set" the next time the operator
  // asks about external APIs / capabilities. Tagged so future
  // chain_hits queries can filter to config-change history.
  let journaledOk = false;
  try {
    const journalResult = await runMemphisJournal({
      content:
        'Brave Search API key configured by operator. memphis_brave_search is now usable (free tier: 2000 queries/month, 1 query/sec).',
      tags: ['config-change', 'brave-search', 'external-api'],
      surface: 'cli',
    });
    journaledOk = journalResult.success;
  } catch {
    // Non-fatal — vault write succeeded, journal is best-effort.
  }

  const result = {
    ok: true,
    vaultKey: VAULT_KEY,
    envPath: envUpdate.path,
    envRef: 'BRAVE_API_KEY=VAULT:brave_api_key',
    journaled: journaledOk,
    warnings,
    nextSteps: [
      'Restart memphis service to load the new env: `systemctl --user restart memphis`',
      'Or run `memphis brave status` to verify the key reaches the Brave API.',
    ],
  };

  if (!json) {
    console.log(chalk.green.bold('\n✓ Brave Search API configured\n'));
    console.log(`  Vault key:  ${chalk.cyan(VAULT_KEY)}`);
    console.log(`  Env ref:    ${chalk.cyan('BRAVE_API_KEY=VAULT:' + VAULT_KEY)}`);
    console.log(`  .env file:  ${chalk.gray(envUpdate.path)}`);
    console.log(
      `  Journal:    ${
        journaledOk
          ? chalk.green('config-change event recorded')
          : chalk.yellow('event NOT recorded (vault write succeeded; bot may not auto-notice the change)')
      }`,
    );
    if (warnings.length > 0) {
      for (const w of warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
    }
    console.log('');
    console.log(chalk.gray('  Next steps:'));
    for (const step of result.nextSteps) {
      console.log(chalk.gray(`    - ${step}`));
    }
    console.log('');
  }

  print(result, json ?? false);
  return true;
}

async function handleBraveStatus(context: CliContext): Promise<boolean> {
  const { json } = context.args;

  const raw = process.env.BRAVE_API_KEY?.trim();
  const configured = Boolean(raw && !raw.startsWith('VAULT:'));
  const vaultUnresolved = Boolean(raw?.startsWith('VAULT:'));

  let probe: { ok: boolean; latencyMs?: number; error?: string } | undefined;
  if (configured) {
    const start = Date.now();
    const out = await runMemphisBraveSearch({ query: 'memphis-status-probe', limit: 1 }, process.env);
    probe = {
      ok: out.error === undefined && out.count >= 0,
      latencyMs: Date.now() - start,
      error: out.error,
    };
  }

  const result = {
    configured,
    vaultUnresolved,
    vaultKey: VAULT_KEY,
    probe,
    suggestion: !configured
      ? vaultUnresolved
        ? `Vault didn't expand "${raw}" — run \`memphis vault list\` to confirm the entry exists, then \`memphis brave configure --key <token>\`.`
        : 'Run `memphis brave configure --key <token>` to set the key. Get one (free) at https://api.search.brave.com/.'
      : probe?.ok
        ? undefined
        : `Brave API call failed: ${probe?.error ?? 'unknown error'}`,
  };

  if (!json) {
    console.log(chalk.bold('\n  Brave Search API status\n'));
    console.log(`  Key:    ${configured ? chalk.green('present') : chalk.red('not set')}`);
    if (vaultUnresolved) {
      console.log(`  Note:   ${chalk.yellow(`env still holds "${raw}" — vault didn't resolve`)}`);
    }
    if (probe) {
      console.log(
        `  Probe:  ${probe.ok ? chalk.green('reachable') : chalk.red('failed')} ${
          probe.latencyMs !== undefined ? chalk.gray(`(${probe.latencyMs}ms)`) : ''
        }`,
      );
      if (!probe.ok) console.log(`  Error:  ${chalk.red(probe.error ?? 'unknown')}`);
    }
    if (result.suggestion) {
      console.log(chalk.gray(`\n  ${result.suggestion}`));
    }
    console.log('');
  }

  print(result, json ?? false);
  return true;
}
