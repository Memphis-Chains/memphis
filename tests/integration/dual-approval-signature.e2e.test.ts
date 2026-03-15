import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import { normalizeIdentity } from '../../src/infra/auth/identity.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import { buildAdminSignatureMessage } from '../../src/infra/runtime/admin-signature.js';

function cfg(db: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined,
    SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined,
    DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30000,
    GEN_MAX_TOKENS: 512,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${db}`,
  };
}

describe('dual approval signature verification', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_API_TOKEN;
    delete process.env.MEMPHIS_ADMIN_SIGNATURE_REQUIRED;
    delete process.env.MEMPHIS_ADMIN_PUBLIC_KEYS_JSON;
    delete process.env.MEMPHIS_DATA_DIR;
  });

  it('requires valid signatures when admin signature checks are enabled', async () => {
    process.env.MEMPHIS_API_TOKEN = 'tok';
    process.env.MEMPHIS_ADMIN_SIGNATURE_REQUIRED = 'true';

    const actor = 'Admin-A';
    const actorNormalized = normalizeIdentity(actor);
    const approver = 'Admin-B';
    const approverNormalized = normalizeIdentity(approver);

    const signerA = generateKeyPairSync('ed25519');
    const signerB = generateKeyPairSync('ed25519');
    process.env.MEMPHIS_ADMIN_PUBLIC_KEYS_JSON = JSON.stringify({
      [actor]: signerA.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      [approver]: signerB.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });

    const dir = mkdtempSync(join(tmpdir(), 'mv5-dual-approval-signature-'));
    process.env.MEMPHIS_DATA_DIR = join(dir, '.memphis-data');

    const conf = cfg(join(dir, 'dual-approval-signature.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
      dualApprovalRepository: c.dualApprovalRepository,
    });

    const missingSignature = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer tok' },
      payload: {
        action: 'freeze',
        initiatorId: actor,
      },
    });
    expect(missingSignature.statusCode).toBe(403);

    const requestPayload = {
      action: 'freeze',
      ttlMs: 5 * 60 * 1000,
      reason: 'incident',
    };
    const requestMessage = buildAdminSignatureMessage({
      action: 'dual_approval.request',
      actorId: actorNormalized,
      payload: requestPayload,
    });
    const requestSignature = sign(
      null,
      Buffer.from(requestMessage, 'utf8'),
      signerA.privateKey,
    ).toString('base64');

    const requestRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer tok' },
      payload: {
        ...requestPayload,
        initiatorId: actor,
        signature: `ed25519:${requestSignature}`,
      },
    });
    expect(requestRes.statusCode).toBe(200);
    const created = requestRes.json() as { request: { requestId: string; stateVersion: number } };

    const badApprove = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/approve',
      headers: { authorization: 'Bearer tok' },
      payload: {
        approvalRequestId: '0d8fef6b-92f2-493f-89fc-5d73898dfc14',
        requestId: created.request.requestId,
        approverId: approver,
        expectedStateVersion: created.request.stateVersion,
        signature: 'ed25519:invalid',
      },
    });
    expect(badApprove.statusCode).toBe(403);

    const approvePayload = {
      approvalRequestId: '803b20d9-4f72-46ee-a903-5537dc71ef7f',
      requestId: created.request.requestId,
      expectedStateVersion: created.request.stateVersion,
    };
    const approveMessage = buildAdminSignatureMessage({
      action: 'dual_approval.approve',
      actorId: approverNormalized,
      payload: approvePayload,
    });
    const approveSignature = sign(
      null,
      Buffer.from(approveMessage, 'utf8'),
      signerB.privateKey,
    ).toString('base64');

    const approveRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/approve',
      headers: { authorization: 'Bearer tok' },
      payload: {
        ...approvePayload,
        approverId: approver,
        signature: `ed25519:${approveSignature}`,
      },
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json() as {
      request: { state: string; stateVersion: number };
      replayed: boolean;
    };
    expect(approveBody.request.state).toBe('approved');
    expect(approveBody.request.stateVersion).toBe(1);
    expect(approveBody.replayed).toBe(false);

    const replayApproveRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/approve',
      headers: { authorization: 'Bearer tok' },
      payload: {
        ...approvePayload,
        approverId: approver,
        signature: `ed25519:${approveSignature}`,
      },
    });
    expect(replayApproveRes.statusCode).toBe(200);
    const replayApproveBody = replayApproveRes.json() as {
      request: { state: string; stateVersion: number };
      replayed: boolean;
    };
    expect(replayApproveBody.request.state).toBe('approved');
    expect(replayApproveBody.request.stateVersion).toBe(1);
    expect(replayApproveBody.replayed).toBe(true);

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: 'Bearer tok' },
    });
    expect(metricsRes.statusCode).toBe(200);
    const metrics = metricsRes.json() as {
      dualApproval?: { transitionsTotal?: number };
    };
    expect(metrics.dualApproval?.transitionsTotal).toBe(2);

    await app.close();
  });
});
