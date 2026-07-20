import { AppError } from '../../../core/errors.js';
import type { CaseChainAdapter } from '../../../infra/storage/case-chain-adapter.js';
import { appendBlock } from '../../../infra/storage/chain-adapter.js';
import { runMemphisSoulRead, runMemphisSoulWrite } from '../../../mcp/tools/soul.js';
import { updateSoulMemory } from '../../../soul/memory.js';
import { soulMemoryUpdateSchema } from '../../../soul/types.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  normalizeSoulWriteUpdatesForToolCall,
  optionalSoulReadSection,
  requiredRecord,
} from '../input-normalization.js';

export function createSoulRuntimeTools(caseAdapter?: CaseChainAdapter): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_soul_read',
      description: 'Read soul memory and persistent identity',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['user', 'self', 'context', 'all'] },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          section: optionalSoulReadSection(args, 'section'),
        };
      },
      async execute(input) {
        return runMemphisSoulRead(input);
      },
    }),
    buildTool({
      name: 'memphis_soul_write',
      description: 'Update soul memory and persistent preferences',
      inputSchema: {
        type: 'object',
        properties: {
          updates: { type: 'object', description: 'Soul memory update payload' },
        },
        required: ['updates'],
      },
      validateInput(args) {
        // Mode B (LLM-direct via gateway tool-executor) bypasses the MCP
        // Zod gate, so prior to this guard a model could send
        // `{ updates: { user: { languages: "Polish" } } }` (string instead
        // of array) or `{ updates: { context: { weirdKey: ... } } }`
        // (extra keys), and updateSoulMemory would either silently drop
        // the bogus fields (operator sees `memory: null` on the next read)
        // or crash with "additions is not iterable" when dedupeAppend
        // tried to spread a non-iterable.
        //
        // We mirror the MCP server schema (server.ts:989) here so both
        // surfaces reject the same shapes the same way.
        const updatesRaw = normalizeSoulWriteUpdatesForToolCall(requiredRecord(args, 'updates'));
        const parsed = soulMemoryUpdateSchema.safeParse(updatesRaw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const path = issue?.path?.join('.') ?? '<root>';
          // 2026-05-12 (P1 of memphis-skill-tools-and-schema-hints):
          // include a concrete CORRECT-SHAPE sample in the error so the
          // LLM can self-correct in one retry instead of flipping array
          // <-> string repeatedly (observed pattern 2026-05-11 23:27).
          throw new AppError(
            'VALIDATION_ERROR',
            `tool memphis_soul_write: invalid \`updates.${path}\`: ${issue?.message ?? 'shape mismatch'}.\n` +
              `Correct shape (string fields use a single string; list fields use array of strings):\n` +
              `{\n` +
              `  "updates": {\n` +
              `    "user":    { "name": "Marcin", "languages": ["pl","en"], "preferences": ["concise"] },\n` +
              `    "self":    { "personality": "direct + audit-trail", "strengths": ["focus"], "learnings": ["read schema first"] },\n` +
              `    "context": { "activeWork": "skill scaffold tooling", "recentDecisions": ["bundle P0+P1 in one PR"] }\n` +
              `  }\n` +
              `}\n` +
              `String-shape fields: user.name, self.personality, context.activeWork.\n` +
              `Array-of-string fields: user.languages, user.preferences, user.expertise, user.integrations, self.strengths, self.learnings, self.evolvedCapabilities, context.recentDecisions.\n` +
              `Unknown keys are rejected (strict schema).`,
            400,
          );
        }
        return { updates: parsed.data };
      },
      async execute(input) {
        return runMemphisSoulWrite(
          input,
          caseAdapter
            ? {
                update: updateSoulMemory,
                caseAdapter: caseAdapter,
                appendSoulAudit: appendBlock,
              }
            : undefined,
        );
      },
    }),
  ];
}
