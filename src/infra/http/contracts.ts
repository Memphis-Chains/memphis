import { z } from 'zod';

import { PROVIDER_NAMES, REQUESTED_PROVIDER_NAMES } from '../../core/types.js';

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  estimated: z.boolean().optional(),
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

const degradationInfoSchema = z.object({
  degraded: z.boolean(),
  tier: z.number().int().min(1).max(4).optional(),
  originalProvider: z.string().optional(),
  actualProvider: z.string(),
  reason: z.string().optional(),
});

const runtimeTelemetrySchema = z.object({
  usage: usageSchema.optional(),
  contextWindowTokens: z.number().int().nonnegative().optional(),
  estimatedPromptTokens: z.number().int().nonnegative().optional(),
  remainingContextTokens: z.number().int().nonnegative().optional(),
  compactionPressure: z
    .object({
      level: z.enum(['low', 'medium', 'high']),
      summaryCount: z.number().int().nonnegative(),
      trimmedMessages: z.number().int().nonnegative(),
      recentMessages: z.number().int().nonnegative(),
    })
    .optional(),
  degraded: z.boolean().optional(),
  degradationReason: z.string().optional(),
});

export const generateResponseSchema = z.object({
  id: z.string().min(1),
  providerUsed: z.enum(PROVIDER_NAMES),
  modelUsed: z.string().min(1).optional(),
  output: z.string().min(1),
  usage: usageSchema.optional(),
  telemetry: runtimeTelemetrySchema.optional(),
  timingMs: z.number().int().nonnegative(),
  trace: providerTraceSchema.optional(),
  mode: z.enum(['canonical', 'provider-only']).optional(),
  degradation: degradationInfoSchema.optional(),
});

const workItemStatusSchema = z.enum(['pending', 'leased', 'completed', 'failed', 'canceled']);

const dispatchWorkSchema = z.object({
  workId: z.string().min(1),
  status: workItemStatusSchema,
  type: z.string().min(1),
  actorId: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  capabilityScope: z.array(z.string().min(1)),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  leaseExpiresAtMs: z.number().int().nonnegative().nullable().optional(),
  heartbeatAtMs: z.number().int().nonnegative().nullable().optional(),
});

export const chatDispatchAcceptedSchema = z.object({
  ok: z.literal(true),
  accepted: z.literal(true),
  requestId: z.string().min(1),
  mode: z.enum(['canonical', 'provider-only']),
  work: dispatchWorkSchema.extend({
    actorId: z.string().min(1),
    conversationId: z.string().min(1),
  }),
});

export const chatDispatchStatusSchema = z.object({
  ok: z.literal(true),
  work: dispatchWorkSchema,
  response: generateResponseSchema.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  resultContractOk: z.boolean().nullable(),
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
export type ChatDispatchAccepted = z.infer<typeof chatDispatchAcceptedSchema>;
export type ChatDispatchStatus = z.infer<typeof chatDispatchStatusSchema>;
