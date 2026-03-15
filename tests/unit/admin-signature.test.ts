import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { normalizeIdentity } from '../../src/infra/auth/identity.js';
import {
  buildAdminSignatureMessage,
  verifyAdminActionSignature,
} from '../../src/infra/runtime/admin-signature.js';

function createEnv(actorId: string, publicKeyPem: string, required = true): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    MEMPHIS_ADMIN_SIGNATURE_REQUIRED: required ? 'true' : 'false',
    MEMPHIS_ADMIN_PUBLIC_KEYS_JSON: JSON.stringify({
      [actorId]: publicKeyPem,
    }),
  };
}

describe('admin signature verification', () => {
  it('accepts a valid ed25519 signature for dual approval action', () => {
    const actorId = 'Admin-A';
    const normalizedActor = normalizeIdentity(actorId);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const payload = { action: 'freeze', ttlMs: 300_000, reason: 'incident' };
    const message = buildAdminSignatureMessage({
      action: 'dual_approval.request',
      actorId: normalizedActor,
      payload,
    });
    const signature = sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');

    const result = verifyAdminActionSignature(
      {
        action: 'dual_approval.request',
        actorId,
        payload,
        signature: `ed25519:${signature}`,
      },
      createEnv(actorId, publicKeyPem, true),
    );

    expect(result.verified).toBe(true);
    expect(result.actorId).toBe(normalizedActor);
  });

  it('rejects invalid signature payload', () => {
    const actorId = 'admin-b';
    const { publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    try {
      verifyAdminActionSignature(
        {
          action: 'dual_approval.approve',
          actorId,
          payload: { requestId: '4a4fec8a-44a5-4904-b8f0-24f52f2fe045', expectedStateVersion: 0 },
          signature: 'ed25519:not-a-valid-signature',
        },
        createEnv(actorId, publicKeyPem, true),
      );
      expect.fail('expected invalid signature to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PERMISSION_DENIED');
    }
  });

  it('allows unverified action when signature requirement is disabled and no key is configured', () => {
    const out = verifyAdminActionSignature(
      {
        action: 'dual_approval.cancel',
        actorId: 'admin-c',
        payload: { requestId: 'f0166b99-a8ce-4f7e-af62-ec2ca50a5fbf', expectedStateVersion: 2 },
      },
      {
        NODE_ENV: 'test',
        MEMPHIS_ADMIN_SIGNATURE_REQUIRED: 'false',
      },
    );

    expect(out.verified).toBe(false);
    expect(out.required).toBe(false);
  });

  it('fails closed when signatures are required but missing', () => {
    const actorId = 'admin-d';
    const { publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    try {
      verifyAdminActionSignature(
        {
          action: 'dual_approval.cancel',
          actorId,
          payload: { requestId: '5687cbeb-ef0f-4ff6-ad95-d6bf0f312d8b', expectedStateVersion: 1 },
        },
        createEnv(actorId, publicKeyPem, true),
      );
      expect.fail('expected missing signature to be denied');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PERMISSION_DENIED');
    }
  });
});
