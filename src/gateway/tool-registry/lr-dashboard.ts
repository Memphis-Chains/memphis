import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const LR_DASHBOARD_TOOL: ToolMeta = {
  name: 'memphis_lr_dashboard',
  tier: 0,
  capabilities: ['read', 'write'],
  description: 'Read status or add entries to the local LR Dashboard SQLite store',
  inputSchema: z
    .object({
      action: z.enum(['status', 'add_entry']).default('status'),
      measuredAt: z.string().min(1).max(64).optional(),
      category: z.string().min(1).max(80).optional(),
      marker: z.string().min(1).max(120).optional(),
      value: z.string().min(1).max(80).optional(),
      unit: z.string().max(40).optional(),
      note: z.string().max(2000).optional(),
      approval_request_id: z.string().optional(),
    })
    .strict(),
  helpText:
    'Use this for operator health-tracking measurements that belong in LR Dashboard, not the Memphis journal. `action=status` reports the managed-app SQLite path and row count. `action=add_entry` inserts one validated row into `${MEMPHIS_DATA_DIR}/apps/lr-dashboard/state/lr.sqlite` without using shell commands, localhost HTTP fetch, or chain writes. For pH measurements use category `body-ph`, marker `urine_ph` or `saliva_ph`, value like `6.8`, and unit `pH`.',
  cliFlags: [
    { name: '--action', description: 'status or add_entry.', takesValue: true },
    { name: '--measured-at', description: 'Measurement timestamp/date, e.g. 2026-07-07.', takesValue: true },
    { name: '--category', description: 'Dashboard category, e.g. body-ph.', takesValue: true },
    { name: '--marker', description: 'Measurement marker, e.g. urine_ph.', takesValue: true },
    { name: '--value', description: 'Measurement value as text.', takesValue: true },
    { name: '--unit', description: 'Measurement unit.', takesValue: true },
    { name: '--note', description: 'Optional short note.', takesValue: true },
  ],
};
