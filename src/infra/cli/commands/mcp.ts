import { createConnection } from 'node:net';
import { invokeNativeMcpAsk, type NativeMcpRequest } from '../../../bridges/mcp-native-gateway.js';
import { startNativeMcpTransport } from '../../../bridges/mcp-native-transport.js';
import { serveMcpHttp } from '../../../mcp/transport/http.js';
import { serveMcpStdio } from '../../../mcp/transport/stdio.js';
import { clearMcpServeState, readMcpServeState, writeMcpServeState } from '../utils/mcp-state.js';
import { print } from '../utils/render.js';
import type { CliContext } from '../context.js';

export async function handleMcpCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const { command, subcommand, json, input, schema, transport, port, durationMs } = args;
  if (command !== 'mcp') return false;

  if (subcommand === 'serve-status') {
    const state = readMcpServeState();
    if (!state) {
      print({ ok: false, mode: 'mcp-serve-status', running: false }, json);
      return true;
    }
    let running = true;
    try {
      process.kill(state.pid, 0);
    } catch {
      running = false;
    }
    print({ ok: true, mode: 'mcp-serve-status', running, state }, json);
    return true;
  }

  if (subcommand === 'serve-stop') {
    const state = readMcpServeState();
    if (!state) {
      print({ ok: true, mode: 'mcp-serve-stop', stopped: false, reason: 'no-state' }, json);
      return true;
    }
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // noop
    }
    clearMcpServeState();
    print({ ok: true, mode: 'mcp-serve-stop', stopped: true, pid: state.pid }, json);
    return true;
  }

  if (subcommand === 'serve') {
    const selectedTransport = transport ?? 'stdio';
    const runMs = durationMs && Number.isFinite(durationMs) ? Math.trunc(durationMs) : 0;
    let stopRequested = false;
    const stop = () => {
      stopRequested = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    if (selectedTransport === 'http') {
      const httpPort = port && Number.isFinite(port) ? Math.trunc(port) : 3001;
      const mcpHttp = await serveMcpHttp(httpPort);
      writeMcpServeState({ pid: process.pid, port: mcpHttp.port, startedAt: new Date().toISOString(), mode: 'running' });
      print({ ok: true, mode: 'mcp-serve', transport: 'http', host: '127.0.0.1', port: mcpHttp.port, durationMs: runMs }, json);

      const startedAt = Date.now();
      while (!stopRequested && (runMs <= 0 || Date.now() - startedAt < runMs)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await mcpHttp.close();
    } else {
      await serveMcpStdio();
      writeMcpServeState({ pid: process.pid, port: 0, startedAt: new Date().toISOString(), mode: 'running' });
      print({ ok: true, mode: 'mcp-serve', transport: 'stdio', durationMs: runMs }, json);

      const startedAt = Date.now();
      while (!stopRequested && (runMs <= 0 || Date.now() - startedAt < runMs)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    clearMcpServeState();
    print({ ok: true, mode: 'mcp-serve-stopped', reason: stopRequested ? 'signal' : 'timeout' }, json);
    return true;
  }

  if (subcommand === 'serve-once') {
    const container = context.getContainer();
    const nativeTransport = await startNativeMcpTransport(
      async (request) =>
        invokeNativeMcpAsk(request, async (params) => {
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
        }),
      { port: port && Number.isFinite(port) ? Math.trunc(port) : 0 },
    );

    const requestPayload: NativeMcpRequest = input && input.trim().length
      ? (JSON.parse(input) as NativeMcpRequest)
      : {
          jsonrpc: '2.0',
          id: 'serve-once-default',
          method: 'memphis.ask',
          params: { input: 'serve once probe', provider: 'local-fallback' },
        };

    const responseText = await new Promise<string>((resolve, reject) => {
      const client = createConnection({ host: nativeTransport.host, port: nativeTransport.port }, () => {
        client.write(JSON.stringify(requestPayload));
      });
      let data = '';
      client.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      client.on('end', () => resolve(data));
      client.on('error', reject);
    });

    await nativeTransport.close();
    print({ ok: true, mode: 'mcp-serve-once', response: JSON.parse(responseText), host: nativeTransport.host, port: nativeTransport.port }, json);
    return true;
  }

  if (schema) {
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

  if (!input || input.trim().length === 0) throw new Error('mcp requires --input with JSON-RPC request payload');

  let request: NativeMcpRequest;
  try {
    request = JSON.parse(input) as NativeMcpRequest;
  } catch {
    print({ ok: false, response: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error: invalid JSON' } } }, json);
    return true;
  }

  if (!new Set(['memphis.ask']).has(request.method)) {
    print(
      {
        ok: false,
        response: { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: `method_not_allowed: ${String(request.method)}` } },
      },
      json,
    );
    return true;
  }

  try {
    const container = context.getContainer();
    const response = await invokeNativeMcpAsk(request, async (params) => {
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
    });
    print({ ok: true, response }, json);
  } catch (error) {
    print(
      {
        ok: false,
        response: {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32602, message: error instanceof Error ? error.message : 'invalid_params' },
        },
      },
      json,
    );
  }
  return true;
}
