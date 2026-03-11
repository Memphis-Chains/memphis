import { createConnection } from 'node:net';

import { type NativeMcpRequest, invokeNativeMcpAsk } from '../../../bridges/mcp-native-gateway.js';
import { startNativeMcpTransport } from '../../../bridges/mcp-native-transport.js';
import { serveMcpHttp } from '../../../mcp/transport/http.js';
import { serveMcpStdio } from '../../../mcp/transport/stdio.js';
import type { CliContext } from '../context.js';
import { clearMcpServeState, readMcpServeState, writeMcpServeState } from '../utils/mcp-state.js';
import { print } from '../utils/render.js';

type McpHandler = (context: CliContext) => Promise<boolean>;

export async function handleMcpCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, schema } = context.args;
  if (command !== 'mcp') return false;
  if (schema) return printMcpSchema(context.args.json);

  const handlers: Partial<Record<string, McpHandler>> = {
    'serve-status': handleServeStatus,
    'serve-stop': handleServeStop,
    serve: handleServeCommand,
    'serve-once': handleServeOnceCommand,
  };
  const handler = subcommand ? handlers[subcommand] : undefined;
  return handler ? handler(context) : handleMcpRequestCommand(context);
}

async function handleServeStatus(context: CliContext): Promise<boolean> {
  const state = readMcpServeState();
  if (!state) {
    print({ ok: false, mode: 'mcp-serve-status', running: false }, context.args.json);
    return true;
  }
  print(
    { ok: true, mode: 'mcp-serve-status', running: isProcessRunning(state.pid), state },
    context.args.json,
  );
  return true;
}

async function handleServeStop(context: CliContext): Promise<boolean> {
  const state = readMcpServeState();
  if (!state) {
    print(
      { ok: true, mode: 'mcp-serve-stop', stopped: false, reason: 'no-state' },
      context.args.json,
    );
    return true;
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    // noop
  }
  clearMcpServeState();
  print({ ok: true, mode: 'mcp-serve-stop', stopped: true, pid: state.pid }, context.args.json);
  return true;
}

async function handleServeCommand(context: CliContext): Promise<boolean> {
  const selectedTransport = context.args.transport ?? 'stdio';
  const runMs =
    context.args.durationMs && Number.isFinite(context.args.durationMs)
      ? Math.trunc(context.args.durationMs)
      : 0;
  const stopState = createStopState();

  try {
    if (selectedTransport === 'http') await runHttpServe(context, runMs, stopState);
    else await runStdioServe(context, runMs, stopState);
  } finally {
    stopState.dispose();
  }

  clearMcpServeState();
  print(
    { ok: true, mode: 'mcp-serve-stopped', reason: stopState.stopRequested ? 'signal' : 'timeout' },
    context.args.json,
  );
  return true;
}

async function handleServeOnceCommand(context: CliContext): Promise<boolean> {
  const nativeTransport = await startNativeMcpTransport(createNativeMcpInvoker(context), {
    port:
      context.args.port && Number.isFinite(context.args.port) ? Math.trunc(context.args.port) : 0,
  });
  const requestPayload = context.args.input?.trim().length
    ? (JSON.parse(context.args.input) as NativeMcpRequest)
    : defaultServeOncePayload();
  const responseText = await sendServeOnceRequest(
    nativeTransport.host,
    nativeTransport.port,
    requestPayload,
  );
  await nativeTransport.close();
  print(
    {
      ok: true,
      mode: 'mcp-serve-once',
      response: JSON.parse(responseText),
      host: nativeTransport.host,
      port: nativeTransport.port,
    },
    context.args.json,
  );
  return true;
}

async function handleMcpRequestCommand(context: CliContext): Promise<boolean> {
  const { input, json } = context.args;
  if (!input || input.trim().length === 0)
    throw new Error('mcp requires --input with JSON-RPC request payload');

  const request = parseMcpRequest(input, json);
  if (!request) return true;
  if (request.method !== 'memphis.ask') {
    print(
      {
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32601, message: `method_not_allowed: ${String(request.method)}` },
        },
      },
      json,
    );
    return true;
  }

  try {
    const response = await invokeNativeMcpAsk(request, createMcpParamsHandler(context));
    print({ ok: true, response }, json);
  } catch (error) {
    print(
      {
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: {
            code: -32602,
            message: error instanceof Error ? error.message : 'invalid_params',
          },
        },
      },
      json,
    );
  }
  return true;
}

async function runHttpServe(
  context: CliContext,
  runMs: number,
  stopState: StopState,
): Promise<void> {
  const httpPort =
    context.args.port && Number.isFinite(context.args.port) ? Math.trunc(context.args.port) : 3001;
  const mcpHttp = await serveMcpHttp(httpPort);
  writeMcpServeState({
    pid: process.pid,
    port: mcpHttp.port,
    startedAt: new Date().toISOString(),
    mode: 'running',
  });
  print(
    {
      ok: true,
      mode: 'mcp-serve',
      transport: 'http',
      host: '127.0.0.1',
      port: mcpHttp.port,
      durationMs: runMs,
    },
    context.args.json,
  );
  await waitForServeStop(runMs, stopState);
  await mcpHttp.close();
}

async function runStdioServe(
  context: CliContext,
  runMs: number,
  stopState: StopState,
): Promise<void> {
  await serveMcpStdio();
  writeMcpServeState({
    pid: process.pid,
    port: 0,
    startedAt: new Date().toISOString(),
    mode: 'running',
  });
  print({ ok: true, mode: 'mcp-serve', transport: 'stdio', durationMs: runMs }, context.args.json);
  await waitForServeStop(runMs, stopState);
}

type StopState = {
  readonly stopRequested: boolean;
  dispose: () => void;
};

function createStopState(): StopState {
  const state = { stopRequested: false };
  const stop = () => {
    state.stopRequested = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    get stopRequested() {
      return state.stopRequested;
    },
    dispose: () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

async function waitForServeStop(runMs: number, stopState: StopState): Promise<void> {
  const startedAt = Date.now();
  while (!stopState.stopRequested && (runMs <= 0 || Date.now() - startedAt < runMs)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function printMcpSchema(json: boolean): boolean {
  print(
    {
      ok: true,
      schema: {
        jsonrpc: '2.0',
        methods: [
          {
            name: 'memphis.ask',
            params: {
              input: 'string (required)',
              provider: 'auto|shared-llm|decentralized-llm|local-fallback (optional)',
              model: 'string (optional)',
            },
            result: {
              output: 'string',
              providerUsed: 'string',
              timingMs: 'number',
            },
          },
        ],
        errors: {
          '-32700': 'parse_error: invalid JSON',
          '-32601': 'method_not_allowed',
          '-32602': 'invalid_params',
        },
      },
    },
    json,
  );
  return true;
}

function parseMcpRequest(input: string, json: boolean): NativeMcpRequest | undefined {
  try {
    return JSON.parse(input) as NativeMcpRequest;
  } catch {
    print(
      {
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse_error: invalid JSON' },
        },
      },
      json,
    );
    return undefined;
  }
}

function defaultServeOncePayload(): NativeMcpRequest {
  return {
    jsonrpc: '2.0',
    id: 'serve-once-default',
    method: 'memphis.ask',
    params: { input: 'serve once probe', provider: 'local-fallback' },
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sendServeOnceRequest(
  host: string,
  port: number,
  requestPayload: NativeMcpRequest,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = createConnection({ host, port }, () => {
      client.write(JSON.stringify(requestPayload));
    });
    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    client.on('end', () => resolve(data));
    client.on('error', reject);
  });
}

function createNativeMcpInvoker(context: CliContext) {
  return async (request: NativeMcpRequest) =>
    invokeNativeMcpAsk(request, createMcpParamsHandler(context));
}

function createMcpParamsHandler(context: CliContext) {
  const container = context.getContainer();
  return async (params: {
    input: string;
    provider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
    model?: string;
  }) => {
    const result = await container.orchestration.generate({
      input: params.input,
      provider: params.provider ?? 'auto',
      model: params.model,
    });
    return {
      output: result.output,
      providerUsed: result.providerUsed,
      timingMs: result.timingMs,
    };
  };
}
