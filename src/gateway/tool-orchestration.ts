import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';

type ToolBatch = {
  mode: 'parallel' | 'serial';
  calls: ChatToolCall[];
};

export type ToolExecutionResult = {
  call: ChatToolCall;
  output: string;
  error?: string;
};

function isConcurrencySafe(
  tool: ChatToolDefinition | undefined,
): boolean {
  return Boolean(tool?.isConcurrencySafe);
}

export function partitionToolCalls(
  toolCalls: ChatToolCall[],
  tools: ChatToolDefinition[],
): ToolBatch[] {
  if (toolCalls.length === 0) return [];

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const batches: ToolBatch[] = [];

  for (const call of toolCalls) {
    const nextMode = isConcurrencySafe(toolMap.get(call.name)) ? 'parallel' : 'serial';
    const current = batches.at(-1);
    if (!current || current.mode !== nextMode) {
      batches.push({ mode: nextMode, calls: [call] });
      continue;
    }
    current.calls.push(call);
  }

  return batches;
}

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );

  return results;
}

async function executeSingleCall(
  call: ChatToolCall,
  execute: (call: ChatToolCall) => Promise<string>,
): Promise<ToolExecutionResult> {
  try {
    const output = await execute(call);
    return { call, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      call,
      output: JSON.stringify({ error: message }),
      error: message,
    };
  }
}

export async function executeToolCalls(
  toolCalls: ChatToolCall[],
  tools: ChatToolDefinition[],
  execute: (call: ChatToolCall) => Promise<string>,
  maxParallel = 4,
): Promise<ToolExecutionResult[]> {
  const batches = partitionToolCalls(toolCalls, tools);
  const executed: ToolExecutionResult[] = [];

  for (const batch of batches) {
    if (batch.mode === 'parallel') {
      const results = await runWithConcurrencyLimit(
        batch.calls,
        maxParallel,
        (call) => executeSingleCall(call, execute),
      );
      executed.push(...results);
      continue;
    }

    for (const call of batch.calls) {
      executed.push(await executeSingleCall(call, execute));
    }
  }

  return executed;
}
