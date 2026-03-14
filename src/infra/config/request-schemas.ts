import { z } from 'zod';

export const chatGenerateSchema = z.object({
  input: z.string().min(1).max(20000),
  provider: z
    .enum(['auto', 'shared-llm', 'decentralized-llm', 'local-fallback', 'ollama'])
    .optional(),
  model: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  strategy: z.enum(['default', 'latency-aware']).optional(),
  options: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(32768).optional(),
      timeoutMs: z.number().int().min(100).max(120000).optional(),
    })
    .optional(),
});

export const vaultInitSchema = z.object({
  passphrase: z.string().min(8).max(512),
  recovery_question: z.string().min(3).max(500),
  recovery_answer: z.string().min(1).max(500),
});

export const vaultEncryptSchema = z.object({
  key: z.string().min(1).max(200),
  plaintext: z.string().min(1).max(20000),
});

export const vaultDecryptSchema = z.object({
  entry: z.object({
    key: z.string().min(1).max(200),
    encrypted: z.string().min(1),
    iv: z.string().min(1),
    id: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    createdAt: z.string().min(1).optional(),
  }),
});

export const modelDProposalSchema = z.object({
  protocol: z.literal('memphis-model-d/v1'),
  from: z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200).optional(),
  }),
  to: z
    .object({
      id: z.string().min(1).max(128).optional(),
      name: z.string().min(1).max(200).optional(),
    })
    .optional(),
  proposal: z.object({
    id: z.string().min(1).max(256),
    title: z.string().min(1).max(500),
    description: z.string().min(1).max(5000),
    proposer: z.string().min(1).max(128),
    type: z.enum(['strategic', 'tactical', 'operational']),
    status: z.enum(['pending', 'voting', 'approved', 'rejected', 'executed']),
    createdAt: z.string().datetime({ offset: true }),
    votingDeadline: z.string().datetime({ offset: true }).optional(),
  }),
});
