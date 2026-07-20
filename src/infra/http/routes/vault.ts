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
  type VaultEntry,
  type VaultInitInput,
} from '../../storage/rust-vault-adapter.js';

export function registerVaultRoutes(app: FastifyInstance): void {
  app.post<{ Body: VaultInitInput }>('/v1/vault/init', async (request, reply) => {
    const parsed = vaultInitSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
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
          error: error.message,
          code: 'VAULT_ALREADY_INITIALIZED',
        });
      }
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_init_failed',
      });
    }
  });

  app.post<{ Body: { key: string; plaintext: string } }>(
    '/v1/vault/encrypt',
    async (request, reply) => {
      const parsed = vaultEncryptSchema.safeParse(request.body);
      if (!parsed.success) {
        writeSecurityAudit({
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
        return reply.status(503).send({
          ok: false,
          error: error instanceof Error ? error.message : 'vault_encrypt_failed',
        });
      }
    },
  );

  app.post<{ Body: { entry: VaultEntry } }>('/v1/vault/decrypt', async (request, reply) => {
    const parsed = vaultDecryptSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
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
        });
      }
      return { ok: true, plaintext: out.plaintext };
    } catch (error) {
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : 'vault_decrypt_failed',
      });
    }
  });

  app.get<{ Querystring: { key?: string } }>('/v1/vault/entries', async (request) => {
    const withIntegrity = listVaultEntryMetadata(
      { surface: 'http', route: '/v1/vault/entries', ip: request.ip },
      process.env,
      request.query?.key,
    );
    writeSecurityAudit({
      action: 'vault.entries.read',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/vault/entries',
      details: { count: withIntegrity.length },
    });
    return { ok: true, count: withIntegrity.length, entries: withIntegrity };
  });
}
