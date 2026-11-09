import { RollbackManager } from '../../../backup/rollback.js';
import { resolveInstallRoot } from '../../../infra/runtime/install-root.js';
import { CaseChainAdapter } from '../../../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../../../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import {
  optionalNonnegativeInteger,
  optionalString,
  optionalStringArray,
  requiredRecord,
  requiredString,
} from '../input-normalization.js';

export type SelfModifyRuntimeToolDeps = {
  evolveSessionRepository?: SqliteEvolveSessionRepository;
  rollback?: RollbackManager;
  caseAdapter?: CaseChainAdapter;
  projectRoot?: string;
  rawEnv?: NodeJS.ProcessEnv;
};

export function createSelfModifyRuntimeTools(
  deps: SelfModifyRuntimeToolDeps,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_self_modify',
      description: 'Submit a code-change request for local operator review; do not send a password',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', minLength: 1 },
          files: { type: 'array', items: { type: 'string' }, minItems: 1 },
          changes: { type: 'object', additionalProperties: { type: 'string' } },
          plan_id: { type: 'string' },
          step_idx: { type: 'integer', minimum: 0 },
        },
        required: ['intent', 'files', 'changes'],
      },
      isDestructive: true,
      validateInput(args) {
        if (Object.prototype.hasOwnProperty.call(args, 'passphrase')) throw new Error('do not send a passphrase to the agent; use the local evolve prepare command');
        return {
          intent: requiredString(args, 'intent'),
          files: optionalStringArray(args, 'files') ?? [],
          changes: requiredRecord(args, 'changes') as Record<string, string>,
          plan_id: optionalString(args, 'plan_id'),
          step_idx: optionalNonnegativeInteger(args, 'step_idx'),
        };
      },
      async execute(input) {
        if (!deps.evolveSessionRepository) {
          return {
            error: 'memphis_self_modify requires evolve session repository in this runtime surface',
          };
        }
        const request = deps.evolveSessionRepository.requestStore().create(
          deps.projectRoot ?? resolveInstallRoot({ rawEnv: deps.rawEnv }), input);
        return { status: 'operator-review-required', requestId: request.id, digest: request.digest,
          action: `Run memphis evolve prepare ${request.id} in a local terminal.` };
      },
    }),
  ];
}
