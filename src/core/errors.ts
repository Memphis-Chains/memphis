import { resolve } from 'node:path';

import { ERROR_SUGGESTIONS } from './errors/templates.js';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'OVERLOAD'
  | 'CONFIG_ERROR'
  | 'INTERNAL_ERROR'
  | 'MISSING_ENV'
  | 'MISSING_OLLAMA'
  | 'INVALID_API_KEY'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED';

export type AppErrorOptions = {
  statusCode?: number;
  details?: Record<string, unknown>;
  suggestion?: string;
  cause?: unknown;
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly suggestion?: string;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 500,
    details?: Record<string, unknown>,
    suggestion?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.suggestion = suggestion;
  }
}

type ErrorTemplateInput = {
  message: string;
  statusCode: number;
  suggestion: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export const errorTemplates = {
  missingEnv(
    input: {
      missingKeys?: string[];
      path?: string;
      message?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ): AppError {
    const path = resolve(input.path ?? '.env');
    const keysSuffix =
      input.missingKeys && input.missingKeys.length > 0
        ? ` Missing keys: ${input.missingKeys.join(', ')}.`
        : '';
    return fromTemplate('MISSING_ENV', {
      message: input.message ?? `Missing or incomplete .env configuration at ${path}.${keysSuffix}`,
      statusCode: 500,
      suggestion: ERROR_SUGGESTIONS.missingEnv,
      details: { path, missingKeys: input.missingKeys ?? [], ...input.details },
      cause: input.cause,
    });
  },
  missingOllama(
    input: {
      commandChecked?: string;
      url?: string;
      message?: string;
      required?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ): AppError {
    const url = input.url ?? 'http://127.0.0.1:11434';
    return fromTemplate('MISSING_OLLAMA', {
      message:
        input.message ?? `Ollama is required but was not detected or is not reachable at ${url}.`,
      statusCode: input.required ? 503 : 500,
      suggestion: ERROR_SUGGESTIONS.missingOllama,
      details: {
        commandChecked: input.commandChecked ?? 'ollama --version',
        url,
        required: input.required ?? true,
        ...input.details,
      },
      cause: input.cause,
    });
  },
  invalidApiKey(
    input: {
      provider?: string;
      status?: number;
      message?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ): AppError {
    const provider = input.provider ?? 'provider';
    return fromTemplate('INVALID_API_KEY', {
      message: input.message ?? `${provider} rejected the configured API key.`,
      statusCode: 401,
      suggestion: ERROR_SUGGESTIONS.invalidApiKey,
      details: { provider, status: input.status, ...input.details },
      cause: input.cause,
    });
  },
  network(
    input: {
      target?: string;
      message?: string;
      statusCode?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ): AppError {
    const target = input.target ?? 'remote service';
    return fromTemplate('NETWORK_ERROR', {
      message: input.message ?? `Network request to ${target} failed.`,
      statusCode: input.statusCode ?? 503,
      suggestion: ERROR_SUGGESTIONS.network,
      details: { target, ...input.details },
      cause: input.cause,
    });
  },
  permission(
    input: {
      path?: string;
      operation?: string;
      message?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ): AppError {
    const path = input.path ?? 'unknown path';
    const operation = input.operation ?? 'access';
    return fromTemplate('PERMISSION_DENIED', {
      message: input.message ?? `Permission denied while attempting to ${operation} ${path}.`,
      statusCode: 403,
      suggestion: ERROR_SUGGESTIONS.permission,
      details: { path, operation, ...input.details },
      cause: input.cause,
    });
  },
} as const;

export function formatCliError(error: unknown, options: { verbose?: boolean } = {}): string {
  const appError = toAppError(error);
  const lines = [`[${appError.code}] ${appError.message}`];

  if (appError.suggestion) {
    lines.push(`Suggestion: ${appError.suggestion}`);
  }

  if (options.verbose && error instanceof Error && error.stack) {
    lines.push(error.stack);
  }

  return lines.join('\n');
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const nodeError = getNodeError(error);
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  const mapped =
    mapNodePermissionError(nodeError, message, lowerMessage, error) ??
    mapNodeNetworkError(nodeError, message, error) ??
    mapKnownAppError(message, error);
  if (mapped) return mapped;

  const fallbackMessage = error instanceof Error ? error.message : 'Internal server error';
  return new AppError(
    'INTERNAL_ERROR',
    fallbackMessage,
    500,
    undefined,
    'Retry with --verbose for stack trace details.',
    error,
  );
}

function mapNodePermissionError(
  nodeError: NodeStyleError | undefined,
  message: string,
  lowerMessage: string,
  cause: unknown,
): AppError | undefined {
  if (
    nodeError?.code !== 'EACCES' &&
    nodeError?.code !== 'EPERM' &&
    !lowerMessage.includes('permission denied')
  )
    return undefined;
  return errorTemplates.permission({
    path: typeof nodeError?.path === 'string' ? nodeError.path : undefined,
    operation: 'access',
    message,
    details: { errno: nodeError?.code },
    cause,
  });
}

function mapNodeNetworkError(
  nodeError: NodeStyleError | undefined,
  message: string,
  cause: unknown,
): AppError | undefined {
  if (
    !nodeError?.code ||
    !['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(
      nodeError.code,
    )
  ) {
    return undefined;
  }
  return errorTemplates.network({
    target:
      typeof nodeError.address === 'string'
        ? `${nodeError.address}${nodeError.port ? `:${String(nodeError.port)}` : ''}`
        : undefined,
    message,
    details: { errno: nodeError.code },
    cause,
  });
}

function mapKnownAppError(message: string, cause: unknown): AppError | undefined {
  if (!(cause instanceof Error)) return undefined;
  if (/provider not configured/i.test(message))
    return new AppError('PROVIDER_UNAVAILABLE', message, 503);
  if (/invalid configuration/i.test(message)) return errorTemplates.missingEnv({ message, cause });
  if (/(http_401|http_403|unauthorized|invalid api key|api key)/i.test(message))
    return errorTemplates.invalidApiKey({ message, cause });
  if (/(fetch failed|network|socket hang up)/i.test(message))
    return errorTemplates.network({ message, cause });
  return undefined;
}

function fromTemplate(code: ErrorCode, input: ErrorTemplateInput): AppError {
  return new AppError(
    code,
    input.message,
    input.statusCode,
    input.details,
    input.suggestion,
    input.cause,
  );
}

type NodeStyleError = Error & {
  code?: string;
  path?: string;
  address?: string;
  port?: number | string;
};

function getNodeError(error: unknown): NodeStyleError | undefined {
  return error instanceof Error ? (error as NodeStyleError) : undefined;
}
