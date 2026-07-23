import { verifyChainIntegrity } from '../../infra/storage/chain-adapter.js';

export type MemphisChainVerifyInput = {
  chain?: string;
};

export type MemphisChainVerifyOutput = {
  ok: boolean;
  chainsChecked: number;
  blockCount: number;
  chain?: string;
  verifiedAt: string;
  error?: string;
};

/**
 * Authoritative, read-only verifier for model-facing diagnostics.
 *
 * Keeping this as a dedicated tool prevents the agent from inferring
 * corruption from a shortened content preview or a failed query.
 */
export async function runMemphisChainVerify(
  input: MemphisChainVerifyInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisChainVerifyOutput> {
  try {
    const result = await verifyChainIntegrity(input.chain, rawEnv);
    return {
      ...result,
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      chainsChecked: 0,
      blockCount: 0,
      chain: input.chain,
      verifiedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
