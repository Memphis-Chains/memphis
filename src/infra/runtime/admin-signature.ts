import { createPublicKey, verify } from 'node:crypto';

import { AppError } from '../../core/errors.js';
import { normalizeIdentity } from '../auth/identity.js';

export type AdminActionType =
  | 'dual_approval.request'
  | 'dual_approval.approve'
  | 'dual_approval.cancel';

export interface VerifyAdminActionSignatureInput {
  action: AdminActionType;
  actorId: string;
  signature?: string;
  payload: Record<string, unknown>;
}

export interface VerifyAdminActionSignatureResult {
  actorId: string;
  required: boolean;
  verified: boolean;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  return value.trim().toLowerCase() === 'true';
}

function signatureRequired(rawEnv: NodeJS.ProcessEnv): boolean {
  return parseBool(rawEnv.MEMPHIS_ADMIN_SIGNATURE_REQUIRED, rawEnv.NODE_ENV === 'production');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return value;
}

export function buildAdminSignatureMessage(input: {
  action: AdminActionType;
  actorId: string;
  payload: Record<string, unknown>;
}): string {
  const canonical = canonicalize({
    action: input.action,
    actorId: input.actorId,
    payload: input.payload,
  });
  return JSON.stringify(canonical);
}

function parseSignatureRegistry(rawEnv: NodeJS.ProcessEnv): Map<string, string> {
  const raw = rawEnv.MEMPHIS_ADMIN_PUBLIC_KEYS_JSON?.trim();
  if (!raw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      'CONFIG_ERROR',
      `invalid MEMPHIS_ADMIN_PUBLIC_KEYS_JSON: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(
      'CONFIG_ERROR',
      'MEMPHIS_ADMIN_PUBLIC_KEYS_JSON must be a JSON object mapping actorId to public key',
      500,
    );
  }

  const out = new Map<string, string>();
  for (const [rawActorId, rawKey] of Object.entries(parsed)) {
    if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      continue;
    }
    out.set(normalizeIdentity(rawActorId), rawKey.trim());
  }
  return out;
}

function decodeSignature(rawSignature: string): Buffer {
  const trimmed = rawSignature.trim();
  if (!trimmed) {
    throw new AppError('PERMISSION_DENIED', 'signature is required', 403);
  }

  let encoding: 'base64' | 'hex' = 'base64';
  let payload = trimmed;

  const tagged = trimmed.indexOf(':');
  if (tagged > 0) {
    const algorithm = trimmed.slice(0, tagged).toLowerCase();
    if (algorithm !== 'ed25519') {
      throw new AppError('PERMISSION_DENIED', `unsupported signature algorithm: ${algorithm}`, 403);
    }
    payload = trimmed.slice(tagged + 1).trim();
  }

  if (/^[0-9a-f]+$/i.test(payload) && payload.length % 2 === 0) {
    encoding = 'hex';
  }

  const decoded = Buffer.from(payload, encoding);
  if (decoded.length === 0) {
    throw new AppError('PERMISSION_DENIED', 'signature payload is empty', 403);
  }

  return decoded;
}

export function verifyAdminActionSignature(
  input: VerifyAdminActionSignatureInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VerifyAdminActionSignatureResult {
  const actorId = normalizeIdentity(input.actorId);
  const required = signatureRequired(rawEnv);
  const registry = parseSignatureRegistry(rawEnv);
  const publicKeyPem = registry.get(actorId);

  if (!publicKeyPem) {
    if (required || input.signature) {
      throw new AppError('PERMISSION_DENIED', 'no admin public key registered for actor', 403, {
        actorId,
      });
    }
    return { actorId, required, verified: false };
  }

  if (!input.signature?.trim()) {
    if (required) {
      throw new AppError('PERMISSION_DENIED', 'signature is required for admin action', 403, {
        actorId,
        action: input.action,
      });
    }
    return { actorId, required, verified: false };
  }

  const message = buildAdminSignatureMessage({
    action: input.action,
    actorId,
    payload: input.payload,
  });

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new AppError(
      'CONFIG_ERROR',
      `invalid public key for actor ${actorId}: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }

  const signature = decodeSignature(input.signature);
  const ok = verify(null, Buffer.from(message, 'utf8'), publicKey, signature);
  if (!ok) {
    throw new AppError('PERMISSION_DENIED', 'invalid admin signature', 403, {
      actorId,
      action: input.action,
    });
  }

  return { actorId, required, verified: true };
}
