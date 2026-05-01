import type { CommandHandler } from './command-handler.js';
import { runOAuthBrowserFlow } from '../../../providers/anthropic/oauth-flow.js';
import { storeVaultSecret } from '../../../security/vault-boundary.js';
import { GATED_OPERATIONS, type GateRule } from '../../auth/operator-gate.js';
import type { CliContext } from '../context.js';
import { CLI_COMPLETION_COMMANDS } from '../registry.js';

interface AuditRow {
  command: string;
  gated: boolean;
  rules: Array<{
    subcommand: string | null;
    conditional: boolean;
    reason: string | null;
  }>;
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

  const rows: AuditRow[] = [];
  for (const command of CLI_COMPLETION_COMMANDS) {
    const matched = rulesByCommand.get(command) ?? [];
    rows.push({
      command,
      gated: matched.length > 0,
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
  const gated = matrix.filter((r) => r.gated).length;
  const ungated = totalCommands - gated;

  if (context.args.json) {
    console.log(
      JSON.stringify(
        {
          totalCommands,
          gated,
          ungated,
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
  console.log(`Gated: ${gated}   Ungated: ${ungated}   Rules in registry: ${GATED_OPERATIONS.length}`);
  console.log('');
  for (const row of matrix) {
    const tag = row.gated ? '✓ gated  ' : '  ungated';
    if (row.gated) {
      const ruleSummary = row.rules
        .map((r) => {
          const sub = r.subcommand ? ` ${r.subcommand}` : '';
          const cond = r.conditional ? ' (conditional)' : '';
          return `${row.command}${sub}${cond}`;
        })
        .join(', ');
      console.log(`${tag}  ${row.command.padEnd(18)} → ${ruleSummary}`);
    } else {
      console.log(`${tag}  ${row.command}`);
    }
  }
  console.log('');
  console.log(
    `For each ungated command, decide whether it mutates state and, if yes, add a rule to GATED_OPERATIONS in src/infra/auth/operator-gate.ts.`,
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
