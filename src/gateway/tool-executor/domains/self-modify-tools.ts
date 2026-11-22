import { RollbackManager } from '../../../backup/rollback.js';
import {
  canonicalEvolveRequest,
  type EvolveRequestPayload,
} from '../../../infra/runtime/evolve-request.js';
import { resolveInstallRoot } from '../../../infra/runtime/install-root.js';
import { CaseChainAdapter } from '../../../infra/storage/case-chain-adapter.js';
import type { SqliteEvolveSessionRepository } from '../../../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';

export type SelfModifyRuntimeToolDeps = {
  evolveSessionRepository?: SqliteEvolveSessionRepository;
  rollback?: RollbackManager;
  caseAdapter?: CaseChainAdapter;
  projectRoot?: string;
  rawEnv?: NodeJS.ProcessEnv;
};

/**
 * The gateway's arm of `memphis_self_modify`.
 *
 * It does NOT read the arguments itself. The rule — which fields exist,
 * what may be in them, what the request looks like afterwards — lives in
 * `canonicalEvolveRequest` (src/infra/runtime/evolve-request.ts), because
 * this tool had three implementations that disagreed: this one, the MCP
 * server's, and the native arm's. The MCP server calls the same function,
 * and the native arm has its mirror in
 * crates/memphis-operator/src/chat_self_modify.rs; the case table in
 * `tests/fixtures/self-modify-contract.json` checks all of them.
 */
export function createSelfModifyRuntimeTools(
  deps: SelfModifyRuntimeToolDeps,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_self_modify',
      description: 'Submit a code-change request for local operator review; do not send a password',
      inputSchema: buildRegistryInputJsonSchema('memphis_self_modify'),
      isDestructive: true,
      validateInput(args) {
        return canonicalEvolveRequest(args).request as EvolveRequestPayload;
      },
      async execute(input) {
        if (!deps.evolveSessionRepository) {
          return {
            error: 'memphis_self_modify requires evolve session repository in this runtime surface',
          };
        }
        const request = deps.evolveSessionRepository
          .requestStore()
          .create(deps.projectRoot ?? resolveInstallRoot({ rawEnv: deps.rawEnv }), input);
        return {
          status: 'operator-review-required',
          requestId: request.id,
          digest: request.digest,
          action: `Run memphis evolve prepare ${request.id} in a local terminal.`,
        };
      },
    }),
  ];
}
