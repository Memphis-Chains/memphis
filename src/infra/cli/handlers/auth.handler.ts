import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandHandler } from './command-handler.js';
import { runOAuthBrowserFlow } from '../../../providers/anthropic/oauth-flow.js';
import { storeVaultSecret } from '../../../security/vault-boundary.js';
import { GATED_OPERATIONS, type GateRule } from '../../auth/operator-gate.js';
import type { CliContext } from '../context.js';
import { CLI_COMPLETION_COMMANDS } from '../registry.js';

interface AuditRow {
  command: string;
  /**
   * True iff GATED_OPERATIONS contains a rule for this command.
   * "Registered" intent — what the operator-gate.ts registry says.
   */
  registered: boolean;
  /**
   * True iff the command's handler file actually invokes
   * `requireOperatorAuth`. Real enforcement (Codex P1 round 2 caught
   * the gap: secret/trust are registered but their handlers never call
   * requireOperatorAuth, so the registry was misleading).
   */
  enforced: boolean;
  /**
   * registered ∧ ¬enforced — registry promises a gate but the handler
   * runs the destructive op silently. This is the exact gap S5-1
   * closes. False for ungated read-only commands.
   */
  gap: boolean;
  rules: Array<{
    subcommand: string | null;
    conditional: boolean;
    reason: string | null;
  }>;
}

/**
 * Scan handler + command files for `requireOperatorAuth` invocations
 * to derive the real enforcement set. Per-file granularity (not
 * per-subcommand) because the audit is a triage tool — granular
 * subcommand-level analysis is the operator's job once the matrix
 * names a suspicious file.
 *
 * Codex P1 round 2: prior audit derived "gated" purely from the
 * registry, which is intent-only — secret/trust were listed in
 * GATED_OPERATIONS but their handlers don't call requireOperatorAuth,
 * so the audit reported gating that didn't exist.
 */
function findEnforcingCommands(): Set<string> {
  const enforcing = new Set<string>();
  const here = dirname(fileURLToPath(import.meta.url));
  // `here` is either `src/infra/cli/handlers/` (dev / ts-node / vitest)
  // or `dist/infra/cli/handlers/` (production npm package). Codex P1
  // round 3 caught this: scanning only `.ts` skipped every file in dist
  // and reported every registered rule as a gap. Accept either source
  // tree relative to the running module.
  const candidates = [here, join(here, '..', 'commands')];
  // Match a real call site: `requireOperatorAuth(` (with the open
  // paren). The bare identifier appears in this file's own JSDoc
  // comments, which Codex P2 round 3 caught — `auth.handler.ts` was
  // counted as enforcing despite never calling the function.
  const CALL_SITE_RE = /\brequireOperatorAuth\s*\(/;
  // Match `command === 'X'`, `command !== 'X'`, or
  // `commands: ['X', 'Y']` so a multi-command dispatcher (e.g.
  // `commands/service.ts` handles both `service` and `reset`) marks
  // ALL of its commands as enforcing when it calls requireOperatorAuth.
  // Codex P1 round 4 caught the basename-only mapping miss.
  const COMMAND_TOKEN_RE = /command\s*[!=]==\s*['"`]([a-z][a-z0-9-]*)['"`]/g;
  const COMMANDS_ARRAY_RE = /\bcommands\s*:\s*\[([^\]]+)\]/g;
  for (const dir of candidates) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
      if (file.endsWith('.d.ts')) continue;
      let content: string;
      try {
        content = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      // Strip import lines and comment lines so we don't match the
      // identifier inside docs.
      const codeLines = content.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('import ') || trimmed.startsWith('//')) return false;
        if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
        return true;
      });
      const code = codeLines.join('\n');
      if (!CALL_SITE_RE.test(code)) continue;

      // Collect every command this file dispatches.
      const dispatched = new Set<string>();
      for (const m of code.matchAll(COMMAND_TOKEN_RE)) dispatched.add(m[1]);
      for (const m of code.matchAll(COMMANDS_ARRAY_RE)) {
        for (const part of m[1].split(',')) {
          const cleaned = part.trim().replace(/^['"`]|['"`]$/g, '');
          if (cleaned && /^[a-z][a-z0-9-]*$/.test(cleaned)) dispatched.add(cleaned);
        }
      }
      // Fallback: if the file has no explicit dispatcher tokens (e.g.
      // a single-command handler that uses canHandle()), use the
      // basename. This keeps vault.handler.ts → 'vault' working.
      if (dispatched.size === 0) {
        const name = file.replace(/\.handler\.(ts|js)$/, '').replace(/\.(ts|js)$/, '');
        dispatched.add(name);
      }
      for (const name of dispatched) enforcing.add(name);
    }
  }
  return enforcing;
}

/**
 * Build the auth-audit matrix. Top-level commands come from
 * CLI_COMPLETION_COMMANDS (the canonical operator-facing surface);
 * GATED_OPERATIONS supplies the auth rules. A command is "gated" when
 * any rule references it — even with a condition or subcommand
 * filter, because the operator-relevant question is "is there ANY
 * passphrase prompt path here, or none at all?"
 *
 * S5-3: this is the matrix the S5-1 sweep will work from. A row with
 * `gated: false` for a destructive command is the gap that S5-1 closes.
 */
export function buildAuthAuditMatrix(): AuditRow[] {
  const rulesByCommand = new Map<string, GateRule[]>();
  for (const rule of GATED_OPERATIONS) {
    const list = rulesByCommand.get(rule.command) ?? [];
    list.push(rule);
    rulesByCommand.set(rule.command, list);
  }
  const enforcing = findEnforcingCommands();

  const rows: AuditRow[] = [];
  for (const command of CLI_COMPLETION_COMMANDS) {
    const matched = rulesByCommand.get(command) ?? [];
    const registered = matched.length > 0;
    const enforced = enforcing.has(command);
    rows.push({
      command,
      registered,
      enforced,
      gap: registered && !enforced,
      rules: matched.map((rule) => ({
        subcommand: Array.isArray(rule.subcommand)
          ? rule.subcommand.join('|')
          : (rule.subcommand ?? null),
        conditional: !!rule.condition,
        reason: rule.reason ?? null,
      })),
    });
  }
  return rows;
}

async function handleAuthAudit(context: CliContext): Promise<boolean> {
  const matrix = buildAuthAuditMatrix();
  const totalCommands = matrix.length;
  const registered = matrix.filter((r) => r.registered).length;
  const enforced = matrix.filter((r) => r.enforced).length;
  const gaps = matrix.filter((r) => r.gap);

  if (context.args.json) {
    console.log(
      JSON.stringify(
        {
          totalCommands,
          registered,
          enforced,
          gapCount: gaps.length,
          rules: GATED_OPERATIONS.length,
          matrix,
        },
        null,
        2,
      ),
    );
    return true;
  }

  console.log(`Memphis CLI auth-audit — ${totalCommands} top-level commands`);
  console.log(
    `Registered: ${registered}   Enforced: ${enforced}   Gaps (registered but not enforced): ${gaps.length}`,
  );
  console.log('');
  if (gaps.length > 0) {
    console.log('GAP — registry promises a gate but the handler runs the op silently:');
    for (const row of gaps) {
      console.log(`  ✗ ${row.command}`);
    }
    console.log('');
  }
  for (const row of matrix) {
    const tag = row.gap
      ? '✗ gap     '
      : row.enforced
        ? '✓ enforced'
        : row.registered
          ? '○ regd'
          : '  ungated ';
    const ruleSummary =
      row.rules.length > 0
        ? ` → ${row.rules
            .map((r) => `${r.subcommand ?? '*'}${r.conditional ? '(cond)' : ''}`)
            .join(', ')}`
        : '';
    console.log(`${tag}  ${row.command.padEnd(18)}${ruleSummary}`);
  }
  console.log('');
  console.log(
    `Gaps above are the S5-1 work list: add requireOperatorAuth to the matching handler.`,
  );
  return true;
}

async function handleAuthAnthropic(context: CliContext): Promise<boolean> {
  console.log('Memphis — Anthropic OAuth login\n');

  const result = await runOAuthBrowserFlow({
    clientId: process.env.ANTHROPIC_OAUTH_CLIENT_ID,
    authorizeUrl: process.env.ANTHROPIC_OAUTH_AUTHORIZE_URL,
    tokenUrl: process.env.ANTHROPIC_OAUTH_TOKEN_URL,
  });

  // Store refresh_token in vault for persistent sessions.
  if (result.tokens.refresh_token) {
    storeVaultSecret('anthropic_oauth_refresh_token', result.tokens.refresh_token, {
      surface: 'cli',
      command: 'auth anthropic',
    });
    console.log('Refresh token stored in vault (key: anthropic_oauth_refresh_token)');
    console.log('\nAdd to .env:');
    console.log('  ANTHROPIC_VAULT_KEY=anthropic_oauth_refresh_token');
    console.log('  DEFAULT_PROVIDER=anthropic');
    console.log('\nThen: memphis service restart');
  } else {
    // No refresh token — store access token directly (short-lived).
    console.log('Warning: no refresh_token returned — session will expire.');
    console.log(`Access token expires at: ${new Date(result.expiresAt).toISOString()}`);
  }

  if (context.args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          hasRefreshToken: !!result.tokens.refresh_token,
          expiresAt: new Date(result.expiresAt).toISOString(),
          scope: result.tokens.scope ?? null,
        },
        null,
        2,
      ),
    );
  }

  return true;
}

export const authCommandHandler: CommandHandler = {
  name: 'auth',
  commands: ['auth'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'auth';
  },
  async handle(context: CliContext): Promise<boolean> {
    const sub = context.args.subcommand;

    if (sub === 'anthropic') {
      return handleAuthAnthropic(context);
    }
    if (sub === 'audit') {
      return handleAuthAudit(context);
    }

    console.log('usage: memphis auth <subcommand>');
    console.log('');
    console.log('subcommands:');
    console.log('  anthropic    Browser-based OAuth login for Anthropic/Claude');
    console.log('  audit        Show auth-gate matrix for all CLI commands [--json]');
    return true;
  },
};
