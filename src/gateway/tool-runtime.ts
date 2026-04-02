import type { ChatToolCall, ChatToolDefinition } from '../providers/index.js';

export type ToolInterruptBehavior = 'block' | 'cancel';

export type ToolExecutionHookContext = {
  call: ChatToolCall;
  surface?: string;
  auditSurface?: string;
  rawEnv?: NodeJS.ProcessEnv;
};

export type ToolExecutionHook = {
  preToolUse?: (
    input: ToolExecutionHookContext,
  ) => Promise<{ allow?: boolean; reason?: string } | void> | { allow?: boolean; reason?: string } | void;
  postToolUse?: (
    input: ToolExecutionHookContext & { result: string },
  ) => Promise<void> | void;
  postToolFailure?: (
    input: ToolExecutionHookContext & { error: string },
  ) => Promise<void> | void;
};

export type RuntimeToolContext = {
  abortSignal?: AbortSignal;
  surface?: string;
  auditSurface?: string;
  rawEnv?: NodeJS.ProcessEnv;
};

export type RuntimeToolDefinition<Input = Record<string, unknown>, Output = unknown> =
  ChatToolDefinition & {
    execute(input: Input, context: RuntimeToolContext): Promise<Output> | Output;
    validateInput?(input: Record<string, unknown>): Input;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    isDestructive: boolean;
    interruptBehavior: ToolInterruptBehavior;
    isEnabled: () => boolean;
  };

export function buildTool<Input = Record<string, unknown>, Output = unknown>(
  tool: Omit<RuntimeToolDefinition<Input, Output>, 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'interruptBehavior' | 'isEnabled'> &
    Partial<
      Pick<
        RuntimeToolDefinition<Input, Output>,
        'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'interruptBehavior' | 'isEnabled'
      >
    >,
): RuntimeToolDefinition<Input, Output> {
  return {
    ...tool,
    isConcurrencySafe: tool.isConcurrencySafe ?? false,
    isReadOnly: tool.isReadOnly ?? false,
    isDestructive: tool.isDestructive ?? false,
    interruptBehavior: tool.interruptBehavior ?? 'block',
    isEnabled: tool.isEnabled ?? (() => true),
  };
}

export function findToolDefinition(
  tools: ChatToolDefinition[],
  name: string,
): ChatToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}
