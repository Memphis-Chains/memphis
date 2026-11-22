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
    description: 'Update soul memory',
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
                name: z.string().optional(),
                languages: z.array(z.string()).optional(),
                preferences: z.array(z.string()).optional(),
                expertise: z.array(z.string()).optional(),
                integrations: z.array(z.string()).optional(),
              })
              .optional(),
            self: z
              .object({
                personality: z.string().optional(),
                strengths: z.array(z.string()).optional(),
                learnings: z.array(z.string()).optional(),
                evolvedCapabilities: z.array(z.string()).optional(),
              })
              .optional(),
            context: z
              .object({
                activeWork: z.string().optional(),
                recentDecisions: z.array(z.string()).optional(),
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
      'Deep-merge an update into the soul memory file. Three target sections (user/self/context) — only supply the keys you actually want to change; everything else stays untouched. Use to record evolved capabilities (`self.evolvedCapabilities`), update operator preferences (`user.preferences`), or refresh active work (`context.activeWork`). Writes are atomic + permission-tightened (0600). Soul memory is the long-form identity narrative — for ephemeral journal entries use memphis_journal instead.',
    cliFlags: [],
  },
} satisfies Record<string, ToolMeta>;
