import { RollbackManager } from '../../../backup/rollback.js';
import { getDataDir } from '../../../config/paths.js';
import { CaseChainAdapter } from '../../../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../../../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { runMemphisSelfModify } from '../../../mcp/tools/self-modify.js';
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
      description: 'Safe self-modification with snapshot, branch isolation, and test gate',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', minLength: 1 },
          files: { type: 'array', items: { type: 'string' }, minItems: 1 },
          changes: { type: 'object', additionalProperties: { type: 'string' } },
          passphrase: { type: 'string' },
          plan_id: { type: 'string' },
          step_idx: { type: 'integer', minimum: 0 },
        },
        required: ['intent', 'files', 'changes'],
      },
      isDestructive: true,
      validateInput(args) {
        return {
          intent: requiredString(args, 'intent'),
          files: optionalStringArray(args, 'files') ?? [],
          changes: requiredRecord(args, 'changes') as Record<string, string>,
          passphrase: optionalString(args, 'passphrase'),
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
        return runMemphisSelfModify(input, {
          sessionRepo: deps.evolveSessionRepository,
          rollback: deps.rollback ?? new RollbackManager(getDataDir()),
          caseAdapter: deps.caseAdapter ?? new CaseChainAdapter(),
          projectRoot: deps.projectRoot,
          rawEnv: deps.rawEnv,
        });
      },
    }),
  ];
}
