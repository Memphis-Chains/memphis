/**
 * Memphis Telegram Channel Setup Wizard
 *
 * Usage:
 *   memphis setup telegram --bot-token <token> [--allowed-user-ids <csv>] [--json]
 *
 * Stores the bot token in vault, writes vault-backed env references,
 * and (by default) probes api.telegram.org/getMe to verify the token.
 * Mirrors the envelope pattern of `memphis setup matrix` but targets
 * the much smaller Telegram surface: no Docker, no registration step.
 */

import { probeVaultCipherCycle, storeVaultSecret } from '../../../security/vault-boundary.js';
import { upsertEnvVars } from '../../config/env-file.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export type TelegramSetupOptions = {
  botToken?: string;
  allowedUserIds?: string;
  allowAllUsers?: boolean;
  skipProbe?: boolean;
  json?: boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export type TelegramSetupResult = {
  ok: boolean;
  vaultKey: string;
  envPath: string;
  envRefs: string[];
  botInfo?: { id: number; username: string };
  probeAttempted: boolean;
  allowedUserIds: string[];
  warnings: string[];
  manualSteps: string[];
};

const VAULT_KEY = 'telegram_bot_token';
const BOT_TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

function parseUserIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function probeGetMe(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ id: number; username: string } | undefined> {
  try {
    const resp = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as {
      ok: boolean;
      result?: { id: number; username: string };
    };
    return data.ok && data.result ? { id: data.result.id, username: data.result.username } : undefined;
  } catch {
    return undefined;
  }
}

export async function runTelegramSetup(
  options: TelegramSetupOptions,
): Promise<TelegramSetupResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  const botToken = options.botToken?.trim();
  if (!botToken) {
    throw new Error(
      'memphis setup telegram requires --bot-token <token> (get one from @BotFather on Telegram).',
    );
  }

  const warnings: string[] = [];
  const manualSteps: string[] = [];

  if (!BOT_TOKEN_SHAPE.test(botToken)) {
    warnings.push(
      'Bot token does not match the expected `<id>:<secret>` shape from @BotFather. Continuing anyway — verify with `memphis telegram status`.',
    );
  }

  const rawIds = options.allowedUserIds?.trim() ?? '';
  const allowedUserIds = rawIds ? parseUserIds(rawIds) : [];
  for (const id of allowedUserIds) {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Invalid allowed user id: "${id}". Telegram user IDs are numeric.`);
    }
  }
  // Security: running the gateway with no allowlist means every Telegram
  // user that finds the bot token can talk to the runtime. Require the
  // operator to either list the allowed ids or consciously opt into open
  // access with `--allow-all-users`.
  if (allowedUserIds.length === 0 && !options.allowAllUsers) {
    throw new Error(
      'memphis setup telegram requires either --allowed-user-ids <csv> (recommended) ' +
        'or --allow-all-users (opens the bot to every Telegram user that finds the token; ' +
        'use ONLY for solo-operator sandboxes).',
    );
  }
  if (allowedUserIds.length === 0 && options.allowAllUsers) {
    warnings.push(
      '--allow-all-users is set: the bot will accept messages from every Telegram user. ' +
        'MEMPHIS_TELEGRAM_ALLOW_ALL=1 is being written so the gateway will actually start; ' +
        'do not use this in any multi-user deployment.',
    );
  }

  const probe = probeVaultCipherCycle({ surface: 'cli', command: 'setup telegram' }, env);
  if (!probe.ok) {
    throw new Error(
      `Vault is not ready for secret storage: ${probe.error}. Run \`memphis init\` first to provision the vault.`,
    );
  }

  let botInfo: TelegramSetupResult['botInfo'];
  const probeAttempted = !options.skipProbe;
  if (probeAttempted) {
    botInfo = await probeGetMe(botToken, fetchImpl);
    if (!botInfo) {
      warnings.push(
        'Could not verify the bot via https://api.telegram.org/bot<token>/getMe. The token is stored anyway; rerun `memphis telegram smoke-test` once the network is reachable.',
      );
    }
  }

  storeVaultSecret(VAULT_KEY, botToken, { surface: 'cli', command: 'setup telegram' }, env);

  const envUpdates = [{ key: 'MEMPHIS_TELEGRAM_BOT_TOKEN', value: `VAULT:${VAULT_KEY}` }];
  if (allowedUserIds.length > 0) {
    envUpdates.push({
      key: 'MEMPHIS_TELEGRAM_ALLOWED_USER_IDS',
      value: allowedUserIds.join(','),
    });
  }
  if (options.allowAllUsers && allowedUserIds.length === 0) {
    envUpdates.push({ key: 'MEMPHIS_TELEGRAM_ALLOW_ALL', value: '1' });
  }
  const envUpdate = upsertEnvVars(envUpdates);

  manualSteps.push(
    'Enable the channel gateway if not already: set MEMPHIS_CHANNEL_GATEWAY_ENABLED=true in .env',
    'Restart Memphis so the gateway picks up the new token:',
    '  memphis service restart        # systemd user service path',
    '  # or Ctrl-C + `npm run dev`    # dev session path',
    'Verify delivery end-to-end: memphis telegram smoke-test',
  );
  if (allowedUserIds.length === 0) {
    manualSteps.push(
      'When you know your Telegram user id (send /start to your bot, watch the logs), rerun:',
      '  memphis setup telegram --bot-token <same-token> --allowed-user-ids <id1,id2>',
    );
  }

  return {
    ok: true,
    vaultKey: VAULT_KEY,
    envPath: envUpdate.path,
    envRefs: envUpdates.map((u) => `${u.key}=${u.value}`),
    botInfo,
    probeAttempted,
    allowedUserIds,
    warnings,
    manualSteps,
  };
}

export async function handleTelegramSetupCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, json, botToken, allowedUserIds, allowAllUsers } = context.args;
  if (command !== 'setup' || subcommand !== 'telegram') return false;

  try {
    const result = await runTelegramSetup({
      botToken,
      allowedUserIds,
      allowAllUsers: Boolean(allowAllUsers),
      json: Boolean(json),
    });

    if (json) {
      print(result, true);
    } else {
      console.log('\n✓ Telegram channel configured');
      console.log(`  Vault key:  ${result.vaultKey}`);
      console.log(`  Env file:   ${result.envPath}`);
      for (const ref of result.envRefs) console.log(`  ${ref}`);
      if (result.botInfo) {
        console.log(`  Bot reached: @${result.botInfo.username} (${result.botInfo.id})`);
      }
      if (result.warnings.length > 0) {
        console.log('\n  Warnings:');
        for (const w of result.warnings) console.log(`    • ${w}`);
      }
      if (result.manualSteps.length > 0) {
        console.log('\n  Next steps:');
        for (const step of result.manualSteps) console.log(`    ${step}`);
      }
      console.log('');
    }

    process.exitCode = result.ok ? 0 : 1;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      print({ ok: false, error: message }, true);
    } else {
      console.error(`\n❌ Telegram setup failed: ${message}\n`);
    }
    process.exitCode = 1;
    return true;
  }
}
