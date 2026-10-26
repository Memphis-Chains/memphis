import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import type { ChatMessage, ChatResponse, ChatToolDefinition } from '../index.js';

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
// A tool call is reported before the usage frame that follows it. This window
// is long enough for the server to send usage, short enough to be invisible
// next to a model turn measured in seconds.
const TOOL_CALL_SETTLE_MS = 120;
export const DEFAULT_CODEX_MODEL = 'astra-gtp6-max';
export const GPT56_SOL_MODEL = 'gpt-5.6-sol';
export const GPT56_SOL_MAX_PRESET = 'gpt-5.6-sol-max';
export const GPT61_SOL_MODEL = 'gpt-6.1-sol';
export const GPT61_SOL_MAX_PRESET = 'gpt-6.1-sol-max';
export const CODEX_SUPPORTED_MODEL_PRESETS = [
  DEFAULT_CODEX_MODEL,
  'gpt-6-astra',
  GPT56_SOL_MAX_PRESET,
  GPT56_SOL_MODEL,
  GPT61_SOL_MAX_PRESET,
  GPT61_SOL_MODEL,
] as const;

const ERROR_MESSAGES = {
  CODEX_NOT_AUTHENTICATED: 'Sign in with ChatGPT using codex login, then retry OpenAI in Memphis.',
  CODEX_BINARY_UNAVAILABLE: 'Codex is unavailable. Install Codex or configure CODEX_BIN.',
  CODEX_TURN_FAILED: 'The OpenAI Codex request failed. Check account usage and retry.',
  CODEX_NO_CREDITS:
    'The OpenAI Codex account has no remaining ChatGPT workspace credits. Refill credits, then retry.',
  CODEX_TIMEOUT: 'The OpenAI Codex request timed out.',
  CODEX_CANCELLED: 'The OpenAI Codex request was cancelled.',
  CODEX_PROTOCOL_ERROR: 'The OpenAI Codex bridge received an invalid response.',
  CODEX_OUTPUT_LIMIT: 'The OpenAI Codex response exceeded the bridge limit.',
  CODEX_MODEL_UNAVAILABLE: 'Codex did not select the requested model. No model fallback was used.',
} as const;

export class CodexProviderError extends Error {
  constructor(public readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CodexProviderError';
  }
}

export function resolveCodexModel(model = DEFAULT_CODEX_MODEL): {
  model: string;
  effort?: 'max';
} {
  const requested = model.trim();
  const normalized = requested.toLowerCase();
  if (['astra-gtp6-max', 'astra-gpt6-max', 'gpt-6-astra-max'].includes(normalized)) {
    return { model: 'gpt-6-astra', effort: 'max' };
  }
  // "GPT-5.6 Sol Max" is a Memphis preset, not an OpenAI model id. The
  // official id stays gpt-5.6-sol and max is sent as reasoning effort.
  if ([GPT56_SOL_MAX_PRESET, `${GPT56_SOL_MODEL} max`].includes(normalized)) {
    return { model: GPT56_SOL_MODEL, effort: 'max' };
  }
  if (normalized === GPT56_SOL_MODEL) return { model: GPT56_SOL_MODEL };
  // GPT-6.1 Sol follows the same shape: the Memphis preset carries the
  // reasoning effort, the official id carries the model.
  if ([GPT61_SOL_MAX_PRESET, `${GPT61_SOL_MODEL} max`].includes(normalized)) {
    return { model: GPT61_SOL_MODEL, effort: 'max' };
  }
  if (normalized === GPT61_SOL_MODEL) return { model: GPT61_SOL_MODEL };
  return { model: requested };
}

/**
 * One model the logged-in ChatGPT account may use, as recorded in the account
 * catalog the Codex CLI keeps under CODEX_HOME.
 */
export type CodexAccountModel = {
  /** Official model id, e.g. `gpt-6.1-sol`. */
  slug: string;
  /** Human-readable name from the catalog. */
  displayName: string;
  /** Context window the account was granted for this model, if any. */
  accountContextWindow: number | undefined;
  /** False for models the CLI keeps out of its own picker. */
  visible: boolean;
};

type CatalogCacheEntry = {
  path: string;
  fingerprint: string;
  models: CodexAccountModel[];
};

let catalogCache: CatalogCacheEntry | undefined;

/**
 * The account's Codex model catalog: which models this workspace may use and
 * how much context each one gets.
 *
 * The catalog is account-specific (it carries an account identity hash) and
 * is maintained by the Codex CLI itself, so it is the only place that knows
 * about models released after Memphis was built. It is cached on the file's
 * (size, mtime) so a CLI refresh is picked up without re-reading the catalog
 * on every turn.
 */
export function readAccountModelCatalog(
  rawEnv: NodeJS.ProcessEnv,
): CodexAccountModel[] | undefined {
  const codexHome = rawEnv.CODEX_HOME?.trim() || join(rawEnv.HOME ?? '', '.codex');
  if (!codexHome) return undefined;
  const path = join(codexHome, 'models_cache.json');
  let fingerprint: string;
  try {
    const stat = statSync(path);
    fingerprint = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    // No catalog on this machine yet (the Codex CLI never ran here). Callers
    // fall back to the documented API ceiling.
    return undefined;
  }
  if (catalogCache && catalogCache.path === path && catalogCache.fingerprint === fingerprint) {
    return catalogCache.models;
  }
  let models: CodexAccountModel[];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { models?: unknown };
    const entries = Array.isArray(parsed.models) ? parsed.models : [];
    models = entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      const slug = typeof record.slug === 'string' ? record.slug : '';
      if (!slug) return [];
      const pool = record.context_window;
      const percent = record.effective_context_window_percent;
      let accountContextWindow: number | undefined;
      if (typeof pool === 'number' && Number.isFinite(pool) && pool > 0) {
        const share =
          typeof percent === 'number' && Number.isFinite(percent) && percent > 0
            ? percent / 100
            : 1;
        const effective = Math.floor(pool * share);
        accountContextWindow = effective > 0 ? effective : undefined;
      }
      return [
        {
          slug,
          displayName: typeof record.display_name === 'string' ? record.display_name : slug,
          accountContextWindow,
          visible: record.visibility !== 'hide',
        },
      ];
    });
  } catch {
    return undefined;
  }
  catalogCache = { path, fingerprint, models };
  return models;
}

/**
 * Slugs of the models this account may use, in catalog order.
 */
export function listAccountModelSlugs(rawEnv: NodeJS.ProcessEnv): string[] {
  return (readAccountModelCatalog(rawEnv) ?? [])
    .filter((model) => model.visible)
    .map((model) => model.slug);
}

/**
 * Context window the logged-in account is granted, read from the Codex model
 * catalog the CLI keeps under CODEX_HOME.
 *
 * The catalog is account-specific (it carries an account identity hash) and
 * stores the granted pool plus the share of it the model may actually use.
 * The server also reports the effective value with each turn, but only after
 * that turn has been sent — reading it here lets Memphis trim the FIRST
 * request of a conversation instead of the second.
 */
export function readAccountContextWindow(
  rawEnv: NodeJS.ProcessEnv,
  model: string,
): number | undefined {
  return readAccountModelCatalog(rawEnv)?.find((entry) => entry.slug === model)
    ?.accountContextWindow;
}

export function codexBinaryAvailable(rawEnv: NodeJS.ProcessEnv): boolean {
  return resolveCodexBinary(rawEnv) !== undefined;
}

function resolveCodexBinary(rawEnv: NodeJS.ProcessEnv): string | undefined {
  const binary = rawEnv.CODEX_BIN || 'codex';
  const candidates =
    isAbsolute(binary) || binary.includes('/')
      ? [binary]
      : (rawEnv.PATH || '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, binary));
  const executable = candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  return executable ? resolve(executable) : undefined;
}

export type CodexChatRequest = {
  messages: ChatMessage[];
  model?: string;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  timeoutMs?: number;
};

type ClientOptions = {
  rawEnv?: NodeJS.ProcessEnv;
  onText?: (text: string) => void;
  signal?: AbortSignal;
  /** Native bridge already owns a process group containing Node and Codex. */
  detached?: boolean;
};

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexProviderError('CODEX_PROTOCOL_ERROR');
  }
  return value as Json;
}

function childEnvironment(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'PATH',
    'CODEX_HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
  ];
  return Object.fromEntries(allowed.flatMap((key) => (rawEnv[key] ? [[key, rawEnv[key]]] : [])));
}

// These overrides belong to the child only. The operator's Codex config and
// credentials are neither copied nor modified. Empty environments remove host
// execution tools; Memphis supplies and executes its own dynamic tools.
function serverArguments(): string[] {
  const overrides: Record<string, unknown> = {
    model_provider: 'openai',
    forced_login_method: 'chatgpt',
    notify: [],
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    'features.shell_tool': false,
    'features.apply_patch_freeform': false,
    'features.apps': false,
    'features.plugins': false,
    'features.codex_hooks': false,
    'features.plugin_hooks': false,
    'features.multi_agent': false,
    'features.code_mode': false,
    'features.memories': false,
    'features.skip_host_skill_discovery': true,
    'skills.include_instructions': false,
  };
  return [
    'app-server',
    '--listen',
    'stdio://',
    ...Object.entries(overrides).flatMap(([key, value]) => [
      '-c',
      `${key}=${JSON.stringify(value)}`,
    ]),
  ];
}

export async function runCodexChat(
  request: CodexChatRequest,
  options: ClientOptions = {},
): Promise<ChatResponse> {
  const rawEnv = options.rawEnv ?? process.env;
  if (options.signal?.aborted) throw new CodexProviderError('CODEX_CANCELLED');
  if (rawEnv.OPENAI_AUTH_MODE && rawEnv.OPENAI_AUTH_MODE !== 'codex') {
    throw new CodexProviderError('CODEX_NOT_AUTHENTICATED');
  }
  const binary = resolveCodexBinary(rawEnv);
  if (!binary) throw new CodexProviderError('CODEX_BINARY_UNAVAILABLE');
  const selected = resolveCodexModel(request.model ?? rawEnv.OPENAI_MODEL);
  const timeoutMs = request.timeoutMs ?? Number(rawEnv.OPENAI_CODEX_TIMEOUT_MS || 180_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw new CodexProviderError('CODEX_PROTOCOL_ERROR');
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new CodexProviderError('CODEX_PROTOCOL_ERROR');
  }
  const tools = request.tools ?? [];
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      throw new CodexProviderError('CODEX_PROTOCOL_ERROR');
    }
  }
  const cwd = await mkdtemp(join(tmpdir(), 'memphis-codex-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  // Owned here so the `finally` block can cancel a pending hand-off.
  let settleTimer: NodeJS.Timeout | undefined;
  const detached = options.detached ?? process.platform !== 'win32';
  try {
    child = spawn(binary, serverArguments(), {
      cwd,
      env: childEnvironment(rawEnv),
      detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const server = child;
    // Deliberately discard provider diagnostics: they can contain credentials,
    // request content or local paths. Public errors use the closed code set.
    server.stderr.resume();
    let sequence = 0;
    let buffer = '';
    let bytes = 0;
    let settled = false;
    let text = '';
    let completedText = '';
    // Account truth from the server, never inferred from a failed turn.
    let creditsExhausted = false;
    // A tool call is handed back to Memphis, but the server reports usage and
    // the account context window right AFTER it. Settling immediately would
    // drop both, so the hand-off waits for a short idle window.
    let pendingToolCalls: ChatResponse['tool_calls'];
    // The account may grant less context than the model's declared API limit.
    let effectiveContextWindow: number | undefined;
    let threadId = '';
    let tokens: ChatResponse['tokens'];
    const pending = new Map<
      number,
      { resolve: (value: Json) => void; reject: (e: Error) => void }
    >();
    let resolveDone!: (result: ChatResponse) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<ChatResponse>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // A process can fail while an initialization RPC is still in flight.
    void done.catch(() => {});
    const fail = (code: keyof typeof ERROR_MESSAGES) => {
      if (settled) return;
      settled = true;
      const error = new CodexProviderError(code);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      rejectDone(error);
    };
    const settle = (toolCalls?: ChatResponse['tool_calls']) => {
      if (settled) return;
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      settled = true;
      resolveDone({
        content: text || completedText,
        model: selected.model,
        provider: 'openai',
        finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(tokens ? { tokens } : {}),
        ...(effectiveContextWindow !== undefined ? { effectiveContextWindow } : {}),
      });
    };
    // The usage frame follows the tool call, so wait for the stream to go
    // quiet before handing control back. Every frame restarts the timer, so a
    // burst of events cannot settle the turn early.
    const finish = (toolCalls?: ChatResponse['tool_calls']) => {
      if (settled) return;
      if (toolCalls?.length) {
        pendingToolCalls = toolCalls;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = undefined;
          const calls = pendingToolCalls;
          pendingToolCalls = undefined;
          settle(calls);
        }, TOOL_CALL_SETTLE_MS);
        return;
      }
      settle(toolCalls);
    };
    const send = (value: unknown) => {
      if (!server.stdin.destroyed) server.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const rpc = (method: string, params: Json): Promise<Json> => {
      if (settled) return Promise.reject(new CodexProviderError('CODEX_TURN_FAILED'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    };
    server.on('error', () => fail('CODEX_BINARY_UNAVAILABLE'));
    server.stdin.on('error', () => fail('CODEX_PROTOCOL_ERROR'));
    server.on('exit', () => fail('CODEX_TURN_FAILED'));
    timer = setTimeout(() => fail('CODEX_TIMEOUT'), timeoutMs);
    abort = () => fail('CODEX_CANCELLED');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk: string) => {
      if (settled) return;
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = undefined;
          const calls = pendingToolCalls;
          pendingToolCalls = undefined;
          settle(calls);
        }, TOOL_CALL_SETTLE_MS);
      }
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > MAX_OUTPUT) return fail('CODEX_OUTPUT_LIMIT');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE) return fail('CODEX_OUTPUT_LIMIT');
        if (!line.trim()) continue;
        try {
          const message = object(JSON.parse(line));
          if (typeof message.id === 'number' && !message.method) {
            const p = pending.get(message.id);
            if (!p) continue;
            pending.delete(message.id);
            if (message.error) {
              p.reject(new CodexProviderError('CODEX_TURN_FAILED'));
            } else {
              p.resolve(object(message.result));
            }
            continue;
          }
          const params = object(message.params ?? {});
          if (params.threadId && threadId && params.threadId !== threadId) continue;
          if (message.method === 'item/tool/call' && message.id !== undefined) {
            const name = params.tool;
            const id = params.callId;
            const args = object(params.arguments);
            if (
              typeof name !== 'string' ||
              !tools.some((tool) => tool.name === name) ||
              typeof id !== 'string' ||
              !id
            ) {
              return fail('CODEX_PROTOCOL_ERROR');
            }
            // Return control to Memphis before executing anything. Its existing
            // policy/tool loop supplies the tool result in the next transcript.
            finish([{ id, name, arguments: args }]);
          } else if (message.id !== undefined && message.method) {
            fail('CODEX_PROTOCOL_ERROR');
          } else if (message.method === 'item/agentMessage/delta') {
            if (typeof params.delta !== 'string') return fail('CODEX_PROTOCOL_ERROR');
            text += params.delta;
            options.onText?.(params.delta);
          } else if (message.method === 'item/completed') {
            const item = object(params.item);
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
              completedText += item.text;
            }
          } else if (message.method === 'account/rateLimits/updated') {
            // A rolling usage window closing is not the same as empty credits.
            // Only the credit snapshot justifies the refill diagnosis.
            const snapshot = params.rateLimits;
            if (typeof snapshot === 'object' && snapshot !== null) {
              const { credits, rateLimitReachedType } = snapshot as Json;
              const exhausted =
                rateLimitReachedType === 'workspace_member_credits_depleted' ||
                (typeof credits === 'object' &&
                  credits !== null &&
                  (credits as Json).hasCredits === false &&
                  (credits as Json).unlimited !== true);
              if (exhausted) creditsExhausted = true;
            }
          } else if (message.method === 'thread/tokenUsage/updated') {
            const usage = object(object(params.tokenUsage).last);
            if (
              ['inputTokens', 'outputTokens', 'totalTokens'].every(
                (key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]),
              )
            ) {
              tokens = {
                prompt: usage.inputTokens as number,
                completion: usage.outputTokens as number,
                total: usage.totalTokens as number,
              };
            }
            const window = (params.tokenUsage as Json).modelContextWindow;
            if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
              effectiveContextWindow = Math.trunc(window);
            }
          } else if (message.method === 'turn/completed') {
            const turn = object(params.turn);
            if (turn.status === 'completed') finish();
            else if (turn.status === 'interrupted') fail('CODEX_CANCELLED');
            else fail(creditsExhausted ? 'CODEX_NO_CREDITS' : 'CODEX_TURN_FAILED');
          }
        } catch {
          fail('CODEX_PROTOCOL_ERROR');
        }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) fail('CODEX_OUTPUT_LIMIT');
    });
    await rpc('initialize', {
      clientInfo: { name: 'memphis', title: 'Memphis', version: '1.13.5' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized', params: {} });
    const account = await rpc('account/read', { refreshToken: false });
    if (!account.account || object(account.account).type !== 'chatgpt') {
      throw new CodexProviderError('CODEX_NOT_AUTHENTICATED');
    }
    const config = object((await rpc('config/read', { includeLayers: false })).config ?? {});
    const disable = (value: unknown) =>
      Object.fromEntries(
        Object.keys(object(value ?? {}))
          .filter((key) => key !== '_default')
          .map((key) => [key, { enabled: false }]),
      );
    const thread = await rpc('thread/start', {
      model: selected.model,
      modelProvider: 'openai',
      allowProviderModelFallback: false,
      ephemeral: true,
      cwd,
      environments: [],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      baseInstructions:
        'You are Memphis, the assistant in the supplied conversation. ' +
        'Continue that conversation using its roles and tool results. ' +
        'Host filesystem, shell and external app tools are unavailable. ' +
        'Use only the supplied Memphis tools when needed.',
      developerInstructions: [
        request.systemPrompt,
        ...request.messages.filter((message) => message.role === 'system').map((m) => m.content),
      ]
        .filter(Boolean)
        .join('\n\n'),
      config: { mcp_servers: disable(config.mcp_servers), plugins: disable(config.plugins) },
      dynamicTools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
    if (thread.model !== selected.model) throw new CodexProviderError('CODEX_MODEL_UNAVAILABLE');
    const id = object(thread.thread).id;
    if (typeof id !== 'string') throw new CodexProviderError('CODEX_PROTOCOL_ERROR');
    threadId = id;
    await rpc('turn/start', {
      threadId,
      model: selected.model,
      ...(selected.effort ? { effort: selected.effort } : {}),
      environments: [],
      input: [
        {
          type: 'text',
          text:
            'Continue this Memphis conversation. Its messages are JSON data, in order:\n' +
            JSON.stringify(request.messages.filter((message) => message.role !== 'system')),
        },
      ],
    });
    return await done;
  } catch (error) {
    if (error instanceof CodexProviderError) throw error;
    throw new CodexProviderError('CODEX_PROTOCOL_ERROR');
  } finally {
    if (timer) clearTimeout(timer);
    if (settleTimer) clearTimeout(settleTimer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    if (child?.pid) {
      const exited = new Promise<void>((resolve) => child!.once('close', () => resolve()));
      try {
        if (detached && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Already exited. */
      }
      if (child.exitCode === null && child.signalCode === null) await exited;
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
