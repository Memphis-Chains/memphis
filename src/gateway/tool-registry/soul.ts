import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const SOUL_TOOLS = {
  memphis_soul_read: {
    name: 'memphis_soul_read',
    tier: 0,
    capabilities: ['read'],
    description: 'Read soul memory',
    inputSchema: z
      .object({
        section: z.enum(['user', 'self', 'context', 'all']).optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Read the operator-private "soul memory" — the curated identity narrative that survives across sessions. Three sections: `user` (operator name, languages, preferences, expertise, integrations), `self` (agent personality, learnings, evolved capabilities), `context` (active work, recent decisions). Default `all` returns every section; pass a specific section to keep the response compact. Soul memory is privacy-sensitive: never log or echo verbatim into untrusted surfaces without redaction.',
    cliFlags: [
      {
        name: '--section',
        description: 'Which section to read: user | self | context | all (default: all).',
        takesValue: true,
      },
    ],
  },
  memphis_soul_write: {
    name: 'memphis_soul_write',
    tier: 0,
    capabilities: ['write'],
    // The bare-array rule lives HERE, in the registry, because the
    // registry is what every surface renders. It used to live only in the
    // native cockpit's hand-written schema, so the model was taught it on
    // one surface and not on the other — and the shape it invents when it
    // is not taught is `{"item": [...]}`, which the runtime rejects. That
    // shape reached `run_soul_write` 18 times in the chat history and was
    // the payload the pre-fd008ea merge clobbered silently (decision
    // #322). One rule, both surfaces.
    description:
      'Update soul memory — send arrays as bare JSON arrays, never wrapped in an object: {"self":{"learnings":["a"]}}, NOT {"self":{"learnings":{"item":["a"]}}}',
    inputSchema: z
      .object({
        updates: z
          .object({
            // The soul manifest has a defined shape
            // (`src/soul/types.ts`). The registry reduced it to a generic
            // record, which lost the structure the write path validates
            // against and left the MCP contract saying nothing about what
            // a soul update may contain.
            user: z
              .object({
                name: z.string().optional().describe('Operator display name.'),
                languages: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Languages the operator writes in. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
                preferences: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'How the operator wants work done. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
                expertise: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Domains the operator works in. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
                integrations: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'External systems the operator uses. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
              })
              .optional(),
            self: z
              .object({
                personality: z.string().optional().describe('Agent personality summary.'),
                strengths: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Demonstrated strengths. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
                learnings: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Lessons learned, each one a complete sentence. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
                evolvedCapabilities: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Capabilities gained through evolution. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
              })
              .optional(),
            context: z
              .object({
                activeWork: z.string().optional().describe('One line on the current task.'),
                recentDecisions: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Short summaries of recent decisions. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
                // Items the OPERATOR has to do — NOT work for the agent.
                //
                // The runtime's own shape (`soulMemoryContextSchema` in
                // `src/soul/types.ts`) declared this field, and the prose
                // above announced it, but the SCHEMA did not — and a zod
                // object strips the keys it does not declare. So the
                // operator's to-do was dropped before it reached the write
                // path: the agent was told to use a field the registry
                // silently removed.
                //
                // The registry is the single truth (ADR-012), so the field
                // is declared HERE, and the native cockpit's schema is a
                // projection of this file.
                operatorTodo: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Items the OPERATOR has to do — NOT work for the agent. Use this field for anything addressed to the operator (things they must send, check or decide); the agent may mention these but must not act on them. Send a bare JSON array like ["first", "second"] — never {"item": [...]}.',
                  ),
              })
              .optional(),
          })
          .refine((updates) => Object.keys(updates).length > 0, {
            message: '`updates` must contain at least one of `user`, `self`, or `context`',
          }),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Deep-merge an update into the soul memory file. Three target sections (user/self/context) — only supply the keys you actually want to change; everything else stays untouched. Use to record evolved capabilities (`self.evolvedCapabilities`), update operator preferences (`user.preferences`), or refresh active work (`context.activeWork`), or record items the OPERATOR has to do (`context.operatorTodo` — for anything addressed to the operator; the agent may mention those but must not act on them). Writes are atomic + permission-tightened (0600). Soul memory is the long-form identity narrative — for ephemeral journal entries use memphis_journal instead.',
    cliFlags: [],
  },
} satisfies Record<string, ToolMeta>;
