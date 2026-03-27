import readline from 'node:readline';

import { executeTuiHostCommand } from './commands.js';
import {
  TUI_HOST_CAPABILITIES,
  TUI_HOST_PROTOCOL_VERSION,
  isTuiHostCapability,
  type TuiHostCancelRequest,
  type TuiHostEvent,
  type TuiHostExecuteRequest,
  type TuiHostRequest,
} from './protocol.js';
import type { CliContext } from '../cli/context.js';

export async function runTuiHost(context: CliContext): Promise<void> {
  if (!context.args.stdioJson) {
    throw new Error('tui host requires --stdio-json');
  }

  emit({
    type: 'ready',
    protocolVersion: TUI_HOST_PROTOCOL_VERSION,
    capabilities: TUI_HOST_CAPABILITIES,
  });

  const active = new Map<string, AbortController>();
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    void handleProtocolLine(line, active);
  });

  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
    process.stdin.on('end', () => resolve());
  });
}

async function handleProtocolLine(
  line: string,
  active: Map<string, AbortController>,
): Promise<void> {
  let request: Partial<TuiHostRequest> | undefined;
  try {
    request = JSON.parse(line) as Partial<TuiHostRequest>;
  } catch {
    emit({ type: 'error', id: '__protocol__', message: 'invalid JSON request' });
    return;
  }

  if (request.type === 'cancel') {
    handleCancelRequest(request as TuiHostCancelRequest, active);
    return;
  }

  if (request.type !== 'execute') {
    emit({
      type: 'error',
      id: typeof request.id === 'string' ? request.id : '__protocol__',
      message: 'unsupported request type',
    });
    return;
  }

  const executeRequest = request as TuiHostExecuteRequest;
  if (!isTuiHostCapability(executeRequest.command)) {
    emit({
      type: 'error',
      id: executeRequest.id,
      message: `unsupported host command: ${String(executeRequest.command)}`,
    });
    return;
  }

  if (active.size > 0) {
    emit({
      type: 'error',
      id: executeRequest.id,
      message: 'host is busy; only one in-flight request is supported',
    });
    return;
  }

  const controller = new AbortController();
  active.set(executeRequest.id, controller);
  emit({ type: 'started', id: executeRequest.id, label: executeRequest.command });

  try {
    const data = await executeTuiHostCommand(executeRequest.command, executeRequest.args, {
      signal: controller.signal,
      emitLine: (level, text) => emit({ type: 'line', id: executeRequest.id, level, text }),
    });
    if (controller.signal.aborted) {
      emit({ type: 'cancelled', id: executeRequest.id });
    } else {
      emit({ type: 'result', id: executeRequest.id, data });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'cancelled', id: executeRequest.id });
    } else {
      emit({
        type: 'error',
        id: executeRequest.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    active.delete(executeRequest.id);
  }
}

function handleCancelRequest(
  request: TuiHostCancelRequest,
  active: Map<string, AbortController>,
): void {
  const controller = active.get(request.id);
  if (!controller) {
    emit({ type: 'error', id: request.id, message: 'unknown request id' });
    return;
  }
  controller.abort();
}

function emit(event: TuiHostEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
