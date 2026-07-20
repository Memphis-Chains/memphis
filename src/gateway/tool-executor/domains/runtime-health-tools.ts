import { runMemphisHealth } from '../../../mcp/tools/health.js';
import { runMemphisRepair } from '../../../mcp/tools/repair.js';
import { runMemphisSelfGovernanceStatus } from '../../../mcp/tools/self-governance-status.js';
import { runMemphisSloStatus } from '../../../mcp/tools/slo-status.js';
import { runMemphisTensorStatus } from '../../../mcp/tools/tensor-status.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';

export function createRuntimeHealthTools(rawEnv?: NodeJS.ProcessEnv): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_health',
      description: 'Check Memphis runtime health',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute() {
        return runMemphisHealth();
      },
    }),
    buildTool({
      name: 'memphis_slo_status',
      description:
        'Runtime SLO snapshot — reads telemetry spans over a time window (default 7 days) and reports each SLO as pass/fail/unavailable',
      inputSchema: {
        type: 'object',
        properties: {
          windowDays: {
            type: 'number',
            description: 'Number of days to scan back (1-90, default 7)',
          },
        },
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute(args: { windowDays?: number }) {
        return runMemphisSloStatus({ windowDays: args.windowDays }, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_governance_status',
      description:
        'Read Memphis self-governance capability state — supervised-operational autonomy readiness, recovery blockers, and required operator actions.',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() {
        return runMemphisSelfGovernanceStatus(rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_tensor_status',
      description:
        'Read Memphis tensor/vector runtime truth — memory embedding dim/provider/persistence, Kartograf tensor mode, and public raw-vector exposure policy.',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute() {
        return runMemphisTensorStatus(rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_repair',
      description:
        'Repair Memphis runtime state — chain integrity, SQLite migrations, derived indexes',
      inputSchema: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Force repair even when manual intervention is recommended',
          },
        },
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        return {
          force: typeof args.force === 'boolean' ? args.force : false,
        };
      },
      async execute(input) {
        return runMemphisRepair({ force: input.force });
      },
    }),
  ];
}
