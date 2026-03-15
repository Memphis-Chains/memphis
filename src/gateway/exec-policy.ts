import { AppError } from '../core/errors.js';

export interface GatewayExecPolicy {
  restrictedMode: boolean;
  allowlist: Map<string, CommandRule>;
  blockedTokens: string[];
}

export interface CommandRule {
  /** Allowed argument patterns (regex). Empty = no arguments allowed. */
  allowedArgs: RegExp[];
  /** Max total argument length. */
  maxArgLength: number;
}

export interface GatewayExecAuthConfig {
  authToken?: string;
}

/**
 * Characters that should NEVER appear in any command passed to a shell.
 * Covers all known shell metacharacters, control characters, and escaping tricks.
 */
// eslint-disable-next-line no-control-regex
const SHELL_METACHAR_RE = /[;&|`$(){}[\]!#~<>\\'\n\r\x00-\x1f\x7f]/;

/**
 * Default command rules: each allowed command has explicit argument validation.
 * Commands not in this map are blocked entirely.
 */
const DEFAULT_COMMAND_RULES: Record<string, CommandRule> = {
  echo: { allowedArgs: [/^[A-Za-z0-9 _.,:=@/-]+$/], maxArgLength: 200 },
  pwd: { allowedArgs: [], maxArgLength: 0 },
  ls: { allowedArgs: [/^-[lah1Rt]+$/, /^[A-Za-z0-9_./@~ -]+$/], maxArgLength: 200 },
  whoami: { allowedArgs: [], maxArgLength: 0 },
  date: { allowedArgs: [/^\+[A-Za-z0-9%: ._-]+$/], maxArgLength: 50 },
  uptime: { allowedArgs: [], maxArgLength: 0 },
};

export function loadGatewayExecPolicy(rawEnv: NodeJS.ProcessEnv = process.env): GatewayExecPolicy {
  const restrictedMode = toBool(rawEnv.GATEWAY_EXEC_RESTRICTED_MODE, true);

  const allowlist = new Map<string, CommandRule>();
  const allowlistNames = splitCsv(rawEnv.GATEWAY_EXEC_ALLOWLIST, Object.keys(DEFAULT_COMMAND_RULES));
  for (const name of allowlistNames) {
    allowlist.set(name, DEFAULT_COMMAND_RULES[name] ?? { allowedArgs: [], maxArgLength: 0 });
  }

  const blockedTokens = splitCsv(rawEnv.GATEWAY_EXEC_BLOCKED_TOKENS, []);

  if (restrictedMode && allowlist.size === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'GATEWAY_EXEC_ALLOWLIST cannot be empty when restricted mode is enabled',
      500,
    );
  }

  return { restrictedMode, allowlist, blockedTokens };
}

/**
 * Parse a command string into [baseCommand, ...args] without using a shell.
 * Rejects any input containing shell metacharacters.
 */
function parseCommand(command: string): { base: string; args: string[] } {
  const trimmed = command.trim();

  // Reject shell metacharacters outright — no escaping tricks
  if (SHELL_METACHAR_RE.test(trimmed)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'command contains blocked shell metacharacter',
      403,
    );
  }

  // Split on whitespace (safe after metachar check)
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'command required', 400);
  }

  // Extract base command (strip any path prefix — only basename matters)
  const rawBase = parts[0];
  const base = rawBase.includes('/') ? rawBase.split('/').pop()! : rawBase;

  return { base, args: parts.slice(1) };
}

export function enforceGatewayExecPolicy(command: string, policy: GatewayExecPolicy): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new AppError('VALIDATION_ERROR', 'command required', 400);
  }

  if (!policy.restrictedMode) {
    // Even in unrestricted mode, block shell metacharacters
    if (SHELL_METACHAR_RE.test(trimmed)) {
      throw new AppError('VALIDATION_ERROR', 'command contains blocked shell metacharacter', 403);
    }
    return;
  }

  const { base, args } = parseCommand(trimmed);

  // Check allowlist
  const rule = policy.allowlist.get(base);
  if (!rule) {
    throw new AppError('VALIDATION_ERROR', `command not in gateway allowlist: ${base}`, 403);
  }

  // If no args allowed and args present, block
  if (rule.allowedArgs.length === 0 && args.length > 0) {
    throw new AppError('VALIDATION_ERROR', `command '${base}' does not accept arguments`, 403);
  }

  // Validate total argument length
  const totalArgLength = args.join(' ').length;
  if (totalArgLength > rule.maxArgLength) {
    throw new AppError('VALIDATION_ERROR', `arguments too long for '${base}' (max ${String(rule.maxArgLength)})`, 403);
  }

  // Validate each argument against allowed patterns
  for (const arg of args) {
    const matches = rule.allowedArgs.some((pattern) => pattern.test(arg));
    if (!matches) {
      throw new AppError('VALIDATION_ERROR', `argument '${arg}' not allowed for command '${base}'`, 403);
    }
  }
}

export function assertGatewayExecAuthConfigured(config: GatewayExecAuthConfig): void {
  if (typeof config.authToken === 'string' && config.authToken.trim().length > 0) {
    return;
  }

  throw new AppError('CONFIG_ERROR', 'gateway /exec requires authToken', 500);
}

export function enforceGatewayExecAuth(
  authHeader: string | undefined,
  config: GatewayExecAuthConfig,
): void {
  assertGatewayExecAuthConfigured(config);
  if (authHeader === `Bearer ${config.authToken}`) {
    return;
  }

  throw new AppError('VALIDATION_ERROR', 'unauthorized', 401);
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return [...fallback];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value.toLowerCase() === 'true';
}
