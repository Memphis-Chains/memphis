import type { FastifyInstance } from 'fastify';

import { AppError } from '../../../core/errors.js';
import {
  decryptVaultEntryValue,
  initializeVault,
  listVaultEntryMetadata,
  storeVaultSecret,
  toVaultEntryMetadata,
} from '../../../security/vault-boundary.js';
import {
  vaultDecryptSchema,
  vaultEncryptSchema,
  vaultInitSchema,
} from '../../config/request-schemas.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';
import {
  VaultAlreadyInitializedError,
  VaultEntryError,
  VaultStateError,
  type VaultEntry,
  type VaultInitInput,
} from '../../storage/rust-vault-adapter.js';

type VaultFailureCode =
  | 'VAULT_INITIALIZATION_FAILED'
  | 'VAULT_SECRET_WRITE_FAILED'
  | 'VAULT_DECRYPT_FAILED'
  | 'VAULT_METADATA_UNAVAILABLE';

function writeVaultRouteAudit(event: Parameters<typeof writeSecurityAudit>[0]): void {
  try {
    writeSecurityAudit(event);
  } catch {
    throw new AppError(
      'INTERNAL_ERROR',
      'Vault audit unavailable; check local audit storage.',
      503,
    );
  }
}

/** Reconstruct known reader errors; never serialize an arbitrary exception. */
function vaultFailure(error: unknown, fallback: VaultFailureCode) {
  if (error instanceof VaultStateError || error instanceof VaultEntryError) {
    const safe =
      error instanceof VaultStateError
        ? new VaultStateError(error.code)
        : new VaultEntryError(error.code);
    return { ok: false, error: safe.message, code: safe.code };
  }
  if (
    error instanceof AppError &&
    (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_LOAD_FAILURE')
  ) {
    return {
      ok: false,
      error: 'Vault bridge unavailable; rebuild the native bridge and run memphis doctor.',
      code: error.code,
    };
  }
  const messages: Record<VaultFailureCode, string> = {
    VAULT_INITIALIZATION_FAILED:
      'Vault initialization failed; run memphis doctor to check configuration.',
    VAULT_SECRET_WRITE_FAILED: 'Vault secret write failed.',
    VAULT_DECRYPT_FAILED: 'Vault entry decryption failed.',
    VAULT_METADATA_UNAVAILABLE: 'Vault entry metadata unavailable; run memphis doctor.',
  };
  return { ok: false, error: messages[fallback], code: fallback };
}

export function registerVaultRoutes(app: FastifyInstance): void {
  app.post<{ Body: VaultInitInput }>('/v1/vault/init', async (request, reply) => {
    const parsed = vaultInitSchema.safeParse(request.body);
    if (!parsed.success) {
      writeVaultRouteAudit({
        action: 'vault.init',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/vault/init',
        details: { reason: 'invalid_payload' },
      });
      throw new AppError('VALIDATION_ERROR', 'Invalid vault init payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const out = initializeVault(
        parsed.data,
        { surface: 'http', route: '/v1/vault/init', ip: request.ip },
        process.env,
      );
      return { ok: true, vault: out };
    } catch (error) {
      if (error instanceof VaultAlreadyInitializedError) {
        return reply.status(409).send({
          ok: false,
          error: 'Vault already initialized; existing state and entries were preserved.',
          code: 'VAULT_ALREADY_INITIALIZED',
        });
      }
      return reply.status(503).send(vaultFailure(error, 'VAULT_INITIALIZATION_FAILED'));
    }
  });

  app.post<{ Body: { key: string; plaintext: string } }>(
    '/v1/vault/encrypt',
    async (request, reply) => {
      const parsed = vaultEncryptSchema.safeParse(request.body);
      if (!parsed.success) {
        writeVaultRouteAudit({
          action: 'vault.encrypt',
          status: 'blocked',
          ip: request.ip,
          route: '/v1/vault/encrypt',
          details: { reason: 'invalid_payload' },
        });
        throw new AppError('VALIDATION_ERROR', 'Invalid vault encrypt payload', 400, {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String),
            message: i.message,
          })),
        });
      }

      try {
        const { key, plaintext } = parsed.data;
        const saved = storeVaultSecret(
          key,
          plaintext,
          { surface: 'http', route: '/v1/vault/encrypt', ip: request.ip },
          process.env,
        );
        return { ok: true, entry: toVaultEntryMetadata(saved) };
      } catch (error) {
        return reply.status(503).send(vaultFailure(error, 'VAULT_SECRET_WRITE_FAILED'));
      }
    },
  );

  app.post<{ Body: { entry: VaultEntry } }>('/v1/vault/decrypt', async (request, reply) => {
    const parsed = vaultDecryptSchema.safeParse(request.body);
    if (!parsed.success) {
      writeVaultRouteAudit({
        action: 'vault.decrypt',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/vault/decrypt',
        details: { reason: 'invalid_payload' },
      });
      throw new AppError('VALIDATION_ERROR', 'Invalid vault decrypt payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    try {
      const out = decryptVaultEntryValue(
        parsed.data.entry,
        { surface: 'http', route: '/v1/vault/decrypt', ip: request.ip },
        process.env,
      );
      if (!out.ok) {
        return reply.status(503).send({
          ok: false,
          error: out.error,
          code: out.errorCode,
        });
      }
      return { ok: true, plaintext: out.plaintext };
    } catch (error) {
      return reply.status(503).send(vaultFailure(error, 'VAULT_DECRYPT_FAILED'));
    }
  });

  app.get<{ Querystring: { key?: string } }>('/v1/vault/entries', async (request, reply) => {
    try {
      const withIntegrity = listVaultEntryMetadata(
        { surface: 'http', route: '/v1/vault/entries', ip: request.ip },
        process.env,
        request.query?.key,
      );
      writeVaultRouteAudit({
        action: 'vault.entries.read',
        status: 'allowed',
        ip: request.ip,
        route: '/v1/vault/entries',
        details: { count: withIntegrity.length },
      });
      return { ok: true, count: withIntegrity.length, entries: withIntegrity };
    } catch (error) {
      return reply.status(503).send(vaultFailure(error, 'VAULT_METADATA_UNAVAILABLE'));
    }
  });
}
