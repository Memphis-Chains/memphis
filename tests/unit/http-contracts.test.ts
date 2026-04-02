import { describe, expect, it } from 'vitest';

import {
  chatDispatchAcceptedSchema,
  chatDispatchStatusSchema,
  generateResponseSchema,
} from '../../src/infra/http/contracts.js';

describe('HTTP response contracts', () => {
  it('accepts valid generate response', () => {
    const parsed = generateResponseSchema.safeParse({
      id: 'gen_1',
      providerUsed: 'deepseek',
      modelUsed: 'deepseek-chat',
      output: 'hi',
      usage: { inputTokens: 1, outputTokens: 1 },
      timingMs: 1,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects invalid generate response', () => {
    const parsed = generateResponseSchema.safeParse({
      id: '',
      providerUsed: 'local-fallback',
      output: '',
      timingMs: -1,
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts valid async dispatch accepted response', () => {
    const parsed = chatDispatchAcceptedSchema.safeParse({
      ok: true,
      accepted: true,
      requestId: 'req_1',
      mode: 'canonical',
      work: {
        workId: 'work_1',
        status: 'pending',
        type: 'chat.generate',
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
        capabilityScope: ['task:chat.generate'],
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAtMs: null,
        heartbeatAtMs: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts valid async dispatch status response', () => {
    const parsed = chatDispatchStatusSchema.safeParse({
      ok: true,
      work: {
        workId: 'work_1',
        status: 'completed',
        type: 'chat.generate',
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
        capabilityScope: ['task:chat.generate'],
        attempts: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAtMs: null,
        heartbeatAtMs: null,
      },
      response: {
        id: 'gen_1',
        providerUsed: 'local-fallback',
        modelUsed: 'local',
        output: 'done',
        timingMs: 3,
      },
      result: {
        id: 'gen_1',
        providerUsed: 'local-fallback',
        modelUsed: 'local',
        output: 'done',
        timingMs: 3,
      },
      resultContractOk: true,
    });

    expect(parsed.success).toBe(true);
  });
});
