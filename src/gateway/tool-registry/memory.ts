import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const JOURNAL_TOOL: ToolMeta = {
  name: 'memphis_journal',
  tier: 0,
  capabilities: ['write'],
  description: 'Save entries to journal chain',
  inputSchema: z
    .object({
      content: z.string().min(1, 'content is required'),
      tags: z.array(z.string()).optional(),
      approval_request_id: z.string().optional(),
    })
    .strict(),
  helpText:
    'Append a journal entry to the operator-private journal chain. The chain is local-only by default; entries persist across restarts and feed cognitive Mode E (weekly reflection). Use for thoughts, decisions in flight, observations — NOT as the response channel back to the operator.',
  cliFlags: [
    {
      name: '--content',
      description: 'Journal entry text. Required.',
      takesValue: true,
      required: true,
    },
    {
      name: '--tags',
      description: 'Comma-separated tags applied to the entry (optional).',
      takesValue: true,
    },
  ],
};
