import { runMemphisExecAnalyze } from '../../../mcp/tools/exec-analyze.js';
import { runMemphisExec } from '../../../mcp/tools/exec.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { optionalString, requiredString } from '../input-normalization.js';

export type ExecRuntimeToolDeps = {
  rawEnv?: NodeJS.ProcessEnv;
  surface?: string;
  sessionId?: string;
};

export function createExecRuntimeTools(deps: ExecRuntimeToolDeps): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_exec_analyze',
      description:
        'Pre-exec analysis: parse + classify side-effects, reversibility, dry-run hint, recommendation. No side effects.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to analyze (not executed)' },
          surface_intent: {
            type: 'string',
            description: "Operator's high-level intent — surfaced unchanged for audit context.",
          },
        },
        required: ['command'],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          command: requiredString(args, 'command'),
          surface_intent: optionalString(args, 'surface_intent'),
        };
      },
      execute(input) {
        return runMemphisExecAnalyze(input);
      },
    }),
    buildTool({
      name: 'memphis_exec',
      description: 'Execute a shell command',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          surface_intent: {
            type: 'string',
            description:
              'Optional operator-stated intent (the prompt that prompted this exec). Audit-logged alongside the predicted-vs-actual outcome.',
          },
        },
        required: ['command'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          command: requiredString(args, 'command'),
          surface_intent: optionalString(args, 'surface_intent'),
        };
      },
      execute(input) {
        try {
          return runMemphisExec(input, deps.rawEnv, {
            surface: deps.surface,
            actorId: deps.sessionId,
          });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  ];
}
