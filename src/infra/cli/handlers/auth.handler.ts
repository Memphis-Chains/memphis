import { runOAuthBrowserFlow } from '../../../providers/anthropic/oauth-flow.js';
import { storeVaultSecret } from '../../../security/vault-boundary.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

async function handleAuthAnthropic(context: CliContext): Promise<boolean> {
  console.log('Memphis — Anthropic OAuth login\n');

  const result = await runOAuthBrowserFlow({
    clientId: process.env.ANTHROPIC_OAUTH_CLIENT_ID,
    authorizeUrl: process.env.ANTHROPIC_OAUTH_AUTHORIZE_URL,
    tokenUrl: process.env.ANTHROPIC_OAUTH_TOKEN_URL,
  });

  // Store refresh_token in vault for persistent sessions.
  if (result.tokens.refresh_token) {
    storeVaultSecret(
      'anthropic_oauth_refresh_token',
      result.tokens.refresh_token,
      { surface: 'cli', command: 'auth anthropic' },
    );
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
    console.log(JSON.stringify({
      ok: true,
      hasRefreshToken: !!result.tokens.refresh_token,
      expiresAt: new Date(result.expiresAt).toISOString(),
      scope: result.tokens.scope ?? null,
    }, null, 2));
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

    console.log('usage: memphis auth <provider>');
    console.log('');
    console.log('providers:');
    console.log('  anthropic    Browser-based OAuth login for Anthropic/Claude');
    return true;
  },
};
