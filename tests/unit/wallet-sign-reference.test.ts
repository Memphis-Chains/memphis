import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

// Independent reference values computed OUTSIDE the implementation
// (see /tmp/wallet-e2e/check.mjs). If the tool's PKCS#8 wrapping or base58
// encoding were wrong, these would not match.
const REF = {
  seedB64: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=',
  pubkey: '2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ',
  msgHash: '779f3ea020986d8fa5fb02943f84e70db10735a9dbb2251e0af074c834fadae5',
  message: Buffer.from('solana:transfer:1SOL').toString('base64'),
};

const { withVaultSecret } = vi.hoisted(() => ({ withVaultSecret: vi.fn() }));

vi.mock('../../src/security/vault-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/security/vault-boundary.js')>();
  return { ...actual, withVaultSecret };
});
vi.mock('../../src/infra/auth/operator-gate.js', () => ({ isSessionAuthorized: () => true }));
vi.mock('../../src/infra/memory/durable-memory.js', () => ({
  storeDurableMemory: vi.fn().mockResolvedValue({}),
}));

import { runMemphisWalletSign } from '../../src/mcp/tools/wallet-sign.js';

describe('wallet-sign against an externally computed reference', () => {
  it('matches the pubkey, hash and a signature that verifies', () => {
    withVaultSecret.mockImplementation((_k: string, _c: unknown, fn: (p: string) => unknown) =>
      fn(REF.seedB64),
    );

    const result = runMemphisWalletSign({ keyName: 'k', message: REF.message });

    expect(result.publicKey).toBe(REF.pubkey);
    expect(result.messageHash).toBe(REF.msgHash);
    expect(Buffer.from(result.signature, 'base64')).toHaveLength(64);

    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(REF.seedB64, 'base64'),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    expect(
      verify(
        null,
        Buffer.from(REF.message, 'base64'),
        pub,
        Buffer.from(result.signature, 'base64'),
      ),
    ).toBe(true);
  });
});
