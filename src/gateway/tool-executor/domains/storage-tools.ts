import { AppError } from '../../../core/errors.js';
import type { CaseChainAdapter } from '../../../infra/storage/case-chain-adapter.js';
import {
  normalizeCaseAppendInput,
  runMemphisCaseAppend,
  runMemphisCaseQuery,
} from '../../../mcp/tools/case-entry.js';
import { runMemphisChainQuery } from '../../../mcp/tools/chain-query.js';
import { runMemphisLrDashboard } from '../../../mcp/tools/lr-dashboard.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  normalizeCaseQueryForToolCall,
  optionalIntegerInRange,
  optionalString,
  requiredRecord,
} from '../input-normalization.js';

export function createStorageRuntimeTools(
  caseAdapter?: CaseChainAdapter,
  rawEnv?: NodeJS.ProcessEnv,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_case_append',
      description: 'Append an entry to the case chain',
      inputSchema: buildRegistryInputJsonSchema('memphis_case_append', {
        propertyDescriptions: {
          entry:
            'Case chain entry payload. You may also pass case_type and its role fields at top level.',
        },
      }),
      validateInput(args) {
        return normalizeCaseAppendInput(args as never) as never;
      },
      async execute(input) {
        return runMemphisCaseAppend(input, caseAdapter ? { adapter: caseAdapter } : undefined);
      },
    }),
    buildTool({
      name: 'memphis_case_query',
      description: 'Query the case chain index',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'object', description: 'Case chain query payload' },
        },
        required: ['query'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        const query = normalizeCaseQueryForToolCall(requiredRecord(args, 'query'));
        optionalIntegerInRange(query, 'limit', 1, 100);
        return { query: query as never };
      },
      async execute(input) {
        return runMemphisCaseQuery(input, caseAdapter ? { adapter: caseAdapter } : undefined);
      },
    }),
    buildTool({
      name: 'memphis_chain_query',
      description: 'Query raw chain blocks with optional filters',
      inputSchema: buildRegistryInputJsonSchema('memphis_chain_query', {
        propertyDescriptions: {
          chain: 'Chain name to query',
          limit: 'Max number of blocks to return',
          offset: 'Starting offset into the result set',
          blockType: 'Optional block type filter',
          contains: 'Optional substring filter',
          tag: 'Optional tag filter',
        },
      }),
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          chain: optionalString(args, 'chain'),
          limit: optionalIntegerInRange(args, 'limit', 1, 100),
          offset: optionalIntegerInRange(args, 'offset', 0),
          blockType: optionalString(args, 'blockType'),
          contains: optionalString(args, 'contains'),
          tag: optionalString(args, 'tag'),
        };
      },
      execute(input) {
        return runMemphisChainQuery(input);
      },
    }),
    buildTool({
      name: 'memphis_lr_dashboard',
      description:
        'Read status or add one validated entry to the local LR Dashboard SQLite store without shell, localhost fetch, or journal writes.',
      inputSchema: buildRegistryInputJsonSchema('memphis_lr_dashboard', {
        propertyDescriptions: {
          action: 'status = inspect DB path/count; add_entry = insert one dashboard row',
          measuredAt: 'Measurement timestamp/date, e.g. 2026-07-07',
          category: 'Dashboard category, e.g. body-ph',
          marker: 'Measurement marker, e.g. urine_ph or saliva_ph',
          value: 'Measurement value as text, e.g. 6.8',
          unit: 'Measurement unit, e.g. pH',
          note: 'Optional short note',
        },
      }),
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        const actionRaw = optionalString(args, 'action') ?? 'status';
        const action: 'status' | 'add_entry' = actionRaw === 'add_entry' ? 'add_entry' : 'status';
        if (actionRaw !== 'status' && actionRaw !== 'add_entry') {
          throw new AppError('VALIDATION_ERROR', 'action must be status or add_entry', 400);
        }
        return {
          action,
          measuredAt: optionalString(args, 'measuredAt'),
          category: optionalString(args, 'category'),
          marker: optionalString(args, 'marker'),
          value: optionalString(args, 'value'),
          unit: optionalString(args, 'unit'),
          note: optionalString(args, 'note'),
        };
      },
      execute(input) {
        return runMemphisLrDashboard(input, rawEnv);
      },
    }),
  ];
}
