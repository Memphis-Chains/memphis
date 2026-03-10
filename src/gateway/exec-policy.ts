import { AppError } from '../core/errors.js';

export interface GatewayExecPolicy {
  restrictedMode: boolean;
  allowlist: string[];
  blockedTokens: string[];
}

const DEFAULT_BLOCKED_TOKENS = ['&&', '||', ';', '|', '>', '<', '$(', '`'];

export function loadGatewayExecPolicy(rawEnv: NodeJS.ProcessEnv = process.env): GatewayExecPolicy {
  const restrictedMode = toBool(rawEnv.GATEWAY_EXEC_RESTRICTED_MODE, true);
  const allowlist = splitCsv(rawEnv.GATEWAY_EXEC_ALLOWLIST, ['echo', 'pwd', 'ls', 'whoami', 'date', 'uptime']);
  const blockedTokens = splitCsv(rawEnv.GATEWAY_EXEC_BLOCKED_TOKENS, DEFAULT_BLOCKED_TOKENS);

  if (restrictedMode && allowlist.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'GATEWAY_EXEC_ALLOWLIST cannot be empty when restricted mode is enabled', 500);
  }

  return { restrictedMode, allowlist, blockedTokens };
}

export function enforceGatewayExecPolicy(command: string, policy: GatewayExecPolicy): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new AppError('VALIDATION_ERROR', 'command required', 400);
  }

  if (!policy.restrictedMode) {
    return;
  }

  for (const token of policy.blockedTokens) {
    if (token && normalized.includes(token)) {
      throw new AppError('VALIDATION_ERROR', `command blocked by token policy: ${token}`, 403);
    }
  }

  const baseCommand = firstToken(normalized);
  if (!baseCommand) {
    throw new AppError('VALIDATION_ERROR', 'command required', 400);
  }

  const allowed = policy.allowlist.some((entry) => entry === baseCommand);
  if (!allowed) {
    throw new AppError('VALIDATION_ERROR', `command not in gateway allowlist: ${baseCommand}`, 403);
  }
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

function firstToken(command: string): string {
  const match = command.match(/^([a-zA-Z0-9_./-]+)/);
  if (!match) return '';
  const fullToken = match[1] || '';
  const normalized = fullToken.split('/').pop() || fullToken;
  return normalized;
}
