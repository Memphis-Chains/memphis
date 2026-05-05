/**
 * `memphis openai` CLI — dedicated UX for adding/checking the
 * OpenAI API key (used by the openai-compatible provider).
 *
 * Memphis already has `OpenAICompatibleProvider` (src/providers/index.ts)
 * — a generic adapter that talks to any /v1/chat/completions endpoint.
 * It's wired through env vars `OPENAI_COMPATIBLE_API_BASE`,
 * `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL`. This handler
 * gives operators a focused command for the *OpenAI* (Codex) case
 * specifically: stores the key in vault, populates the three env vars
 * with sensible defaults pointing at api.openai.com, and journals a
 * config-change event so the bot's chain_hits notices the new
 * capability next turn.
 *
 * Operator's 2026-05-05 ask was about wiring Codex. OpenAI doesn't
 * publish a public OAuth flow (Admin API is static-key only), so this
 * is the API-key path. The default model is intentionally
 * `gpt-5-codex` — operator can override via `--model`.
 *
 * Subcommands:
 *   - `configure --key <sk-...> [--model <name>]`  — store + activate
 *   - `status`                                     — show key + model
 */

import chalk from 'chalk';

import type { CommandHandler } from './command-handler.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { storeVaultSecret } from '../../../security/vault-boundary.js';
import { upsertEnvVars } from '../../config/env-file.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

const VAULT_KEY = 'openai_api_key';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5-codex';

export const openaiCommandHandler: CommandHandler = {
  name: 'openai',
  commands: ['openai'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'openai';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      configure: () => handleOpenAIConfigure(context),
      status: () => handleOpenAIStatus(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.status;
    if (!handler) {
      throw new Error(
        `Unknown subcommand: memphis openai ${subcommand}. Try: configure | status`,
      );
    }
    return handler();
  },
};

async function handleOpenAIConfigure(context: CliContext): Promise<boolean> {
  const { json, key, model } = context.args as {
    json?: boolean;
    key?: string;
    model?: string;
  };

  if (!key || key.trim().length === 0) {
    throw new Error(
      'memphis openai configure --key <sk-...> required. Get a key at https://platform.openai.com/api-keys.',
    );
  }

  const trimmed = key.trim();
  const chosenModel = model?.trim() || DEFAULT_MODEL;

  // OpenAI keys typically start with "sk-" and are 40+ chars. Soft warn
  // on shape mismatch — OpenAI's format isn't published as a stable
  // contract, but a paste error usually surfaces here.
  const looksValid = /^sk-[A-Za-z0-9_-]{20,}$/.test(trimmed);
  const warnings: string[] = [];
  if (!looksValid) {
    warnings.push(
      'Key does not match the typical "sk-..." OpenAI format. Continuing — verify with `memphis openai status`.',
    );
  }

  storeVaultSecret(
    VAULT_KEY,
    trimmed,
    { surface: 'cli', command: 'openai configure' },
    process.env,
  );

  // Memphis's openai-compatible provider reads three env vars. We point
  // them all at OpenAI proper. If the operator was using these for
  // DeepSeek/OpenRouter/etc, this command will overwrite that config —
  // surface a warning so they can recover.
  const previousBase = process.env.OPENAI_COMPATIBLE_API_BASE?.trim();
  if (previousBase && previousBase !== DEFAULT_BASE_URL) {
    warnings.push(
      `OPENAI_COMPATIBLE_API_BASE was previously "${previousBase}" — this command overwrites it with ${DEFAULT_BASE_URL}. If you need that other endpoint, restore it manually after.`,
    );
  }

  const envUpdate = upsertEnvVars([
    { key: 'OPENAI_COMPATIBLE_API_BASE', value: DEFAULT_BASE_URL },
    { key: 'OPENAI_COMPATIBLE_API_KEY', value: `VAULT:${VAULT_KEY}` },
    { key: 'OPENAI_COMPATIBLE_MODEL', value: chosenModel },
  ]);

  // Make values visible to the current process.
  process.env.OPENAI_COMPATIBLE_API_BASE = DEFAULT_BASE_URL;
  process.env.OPENAI_COMPATIBLE_API_KEY = trimmed;
  process.env.OPENAI_COMPATIBLE_MODEL = chosenModel;

  let journaledOk = false;
  try {
    const journalResult = await runMemphisJournal({
      content: `OpenAI provider configured by operator. baseUrl=${DEFAULT_BASE_URL}, model=${chosenModel}. Memphis can now route to OpenAI (Codex etc.) via the openai-compatible provider.`,
      tags: ['config-change', 'openai', 'external-api', 'provider'],
      surface: 'cli',
    });
    journaledOk = journalResult.success;
  } catch {
    // Non-fatal — vault + env writes succeeded, journal is best-effort.
  }

  const result = {
    ok: true,
    vaultKey: VAULT_KEY,
    envPath: envUpdate.path,
    envRefs: [
      'OPENAI_COMPATIBLE_API_BASE=https://api.openai.com/v1',
      'OPENAI_COMPATIBLE_API_KEY=VAULT:openai_api_key',
      `OPENAI_COMPATIBLE_MODEL=${chosenModel}`,
    ],
    journaled: journaledOk,
    warnings,
    nextSteps: [
      'Restart memphis service to load the new env: `systemctl --user restart memphis`',
      'Or run `memphis openai status` to verify the key reaches OpenAI.',
    ],
  };

  if (!json) {
    console.log(chalk.green.bold('\n✓ OpenAI provider configured\n'));
    console.log(`  Vault key:  ${chalk.cyan(VAULT_KEY)}`);
    console.log(`  Base URL:   ${chalk.cyan(DEFAULT_BASE_URL)}`);
    console.log(`  Model:      ${chalk.cyan(chosenModel)}`);
    console.log(`  .env file:  ${chalk.gray(envUpdate.path)}`);
    console.log(
      `  Journal:    ${
        journaledOk
          ? chalk.green('config-change event recorded')
          : chalk.yellow('event NOT recorded (vault write succeeded; bot may not auto-notice)')
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

async function handleOpenAIStatus(context: CliContext): Promise<boolean> {
  const { json } = context.args;

  const rawKey = process.env.OPENAI_COMPATIBLE_API_KEY?.trim() ?? '';
  const baseUrl = process.env.OPENAI_COMPATIBLE_API_BASE?.trim() ?? '';
  const model = process.env.OPENAI_COMPATIBLE_MODEL?.trim() ?? '';
  const configured = rawKey.length > 0 && !rawKey.startsWith('VAULT:');
  const vaultUnresolved = rawKey.startsWith('VAULT:');
  const targetsOpenAI = baseUrl === DEFAULT_BASE_URL;

  let probe: { ok: boolean; latencyMs?: number; error?: string; modelsListed?: number } | undefined;
  if (configured) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${baseUrl || DEFAULT_BASE_URL}/models`, {
        headers: {
          Authorization: `Bearer ${rawKey}`,
          'User-Agent': 'Memphis-Agent/1.0 (sovereign-runtime)',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        const data = (await response.json()) as { data?: unknown[] };
        probe = {
          ok: true,
          latencyMs: Date.now() - start,
          modelsListed: Array.isArray(data.data) ? data.data.length : 0,
        };
      } else {
        let hint = '';
        if (response.status === 401) hint = ' (key rejected — check it)';
        else if (response.status === 429) hint = ' (rate-limit / quota)';
        probe = {
          ok: false,
          latencyMs: Date.now() - start,
          error: `HTTP ${response.status}${hint}`,
        };
      }
    } catch (err) {
      probe = {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const result = {
    configured,
    vaultUnresolved,
    targetsOpenAI,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    model: model || '<unset>',
    vaultKey: VAULT_KEY,
    probe,
    suggestion: !configured
      ? vaultUnresolved
        ? `Vault didn't expand "${rawKey}" — verify the entry exists (\`memphis vault list\`), then \`memphis openai configure --key <sk-...>\`.`
        : 'Run `memphis openai configure --key <sk-...>` to set the key. Get one at https://platform.openai.com/api-keys.'
      : !targetsOpenAI
        ? `OPENAI_COMPATIBLE_API_BASE points at "${baseUrl}", not OpenAI proper. If that's intentional (DeepSeek / OpenRouter / local), ignore. Otherwise re-run \`memphis openai configure\` to reset to ${DEFAULT_BASE_URL}.`
        : probe?.ok
          ? undefined
          : `OpenAI API call failed: ${probe?.error ?? 'unknown error'}`,
  };

  if (!json) {
    console.log(chalk.bold('\n  OpenAI provider status\n'));
    console.log(`  Key:    ${configured ? chalk.green('present') : chalk.red('not set')}`);
    if (vaultUnresolved) {
      console.log(`  Note:   ${chalk.yellow(`env still holds "${rawKey}" — vault didn't resolve`)}`);
    }
    console.log(
      `  Base:   ${targetsOpenAI ? chalk.green(baseUrl || DEFAULT_BASE_URL) : chalk.yellow(baseUrl || '<unset>')}`,
    );
    console.log(`  Model:  ${chalk.cyan(model || '<unset>')}`);
    if (probe) {
      console.log(
        `  Probe:  ${probe.ok ? chalk.green('reachable') : chalk.red('failed')} ${
          probe.latencyMs !== undefined ? chalk.gray(`(${probe.latencyMs}ms)`) : ''
        }`,
      );
      if (probe.modelsListed !== undefined) {
        console.log(`  Models: ${chalk.gray(`${probe.modelsListed} listed`)}`);
      }
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
