import { z } from 'zod';

export const chatGenerateSchema = z.object({
  input: z.string().min(1).max(20000),
  provider: z.enum(['auto', 'shared-llm', 'decentralized-llm', 'local-fallback']).optional(),
  model: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
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
  }),
});
