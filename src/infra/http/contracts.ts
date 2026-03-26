import { z } from 'zod';

import { PROVIDER_NAMES, REQUESTED_PROVIDER_NAMES } from '../../core/types.js';

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

const providerTraceSchema = z.object({
  strategy: z.enum(['default', 'latency-aware']),
  requestedProvider: z.enum(REQUESTED_PROVIDER_NAMES),
  attempts: z.array(
    z.object({
      attempt: z.number().int().positive(),
      provider: z.enum(PROVIDER_NAMES),
      viaFallback: z.boolean(),
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
  ),
});

export const generateResponseSchema = z.object({
  id: z.string().min(1),
  providerUsed: z.enum(PROVIDER_NAMES),
  modelUsed: z.string().min(1).optional(),
  output: z.string().min(1),
  usage: usageSchema.optional(),
  timingMs: z.number().int().nonnegative(),
  trace: providerTraceSchema.optional(),
});

export const providersHealthResponseSchema = z.object({
  defaultProvider: z.enum(PROVIDER_NAMES),
  providers: z.array(
    z.object({
      name: z.enum(PROVIDER_NAMES),
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
  ),
});

export type GenerateResponse = z.infer<typeof generateResponseSchema>;
