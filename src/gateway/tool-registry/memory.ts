import { z } from 'zod';

import { JOURNAL_TARGET_CHAINS } from '../../memory/chain-catalog.js';
import type { ToolMeta } from '../tool-metadata.js';

export const JOURNAL_TOOL = {
  name: 'memphis_journal',
  tier: 0,
  capabilities: ['write'],
  description: 'Save entries to journal chain',
  inputSchema: z
    .object({
      content: z.string().min(1, 'content is required'),
      tags: z.array(z.string()).optional(),
      // Which chain to append to.
      //
      // The MCP server used to carry its own copy of this enum and the
      // registry carried none, so the two disagreed: the MCP surface
      // accepted `chain` and this schema — which is `.strict()` — rejected
      // it. The allowlist is the one place the legal chains are written
      // down (`JOURNAL_TARGET_CHAINS`, checked against the native arm by
      // `tests/fixtures/journal-target-chains-contract.json`), so the
      // schema reads it from there instead of restating it.
      chain: z.enum(JOURNAL_TARGET_CHAINS).optional(),
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
} satisfies ToolMeta;
