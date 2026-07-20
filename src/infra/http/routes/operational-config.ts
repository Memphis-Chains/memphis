/* eslint-disable no-restricted-syntax -- operational config routes intentionally inspect and update the live process environment */
import type { FastifyInstance } from 'fastify';

import { setDotEnvValues } from '../../config/dotenv-file.js';
import { performHotReload, redactFieldValue } from '../../config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
  requiresElevatedTier,
  requiresRestart,
} from '../../config/mutability.js';
import { envSchema } from '../../config/schema.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';

export function registerOperationalConfigRoutes(app: FastifyInstance): void {
  // GET /v1/ops/config/show — redacted view of the current hot-reloadable env
  // surface + field classification. Never echoes secret values.
  //
  // Codex P1 fix: when `?key=…` is supplied, it must appear in
  // listKnownFields(). Without the whitelist, an authenticated caller
  // could pass any env var name (e.g. legacy operator-only credentials
  // not tracked in the schema) and the response would echo the value
  // verbatim because redactFieldValue only masks keys it knows are
  // `secret`. This endpoint is for inspecting Memphis runtime config,
  // not arbitrary process.env exfiltration.
  app.get('/v1/ops/config/show', async (request, reply) => {
    const query = request.query as { key?: string } | undefined;
    const known = listKnownFields();
    const knownKeySet = new Set(known.map((k) => k.key));

    if (query?.key !== undefined && !knownKeySet.has(query.key)) {
      return reply.status(400).send({
        ok: false,
        error: `Unknown config key: ${query.key}. /v1/ops/config/show only exposes keys defined in envSchema; use GET /v1/ops/config/show (no key) to list them.`,
        requestedKey: query.key,
      });
    }

    const shownKeys = query?.key ? [query.key] : known.map((k) => k.key);
    const values: Record<string, string> = {};
    for (const key of shownKeys) {
      const raw = process.env[key];
      if (raw === undefined) continue;
      values[key] = redactFieldValue(key, raw);
    }
    return {
      ok: true,
      fields: known,
      values,
      requestedKey: query?.key ?? null,
    };
  });

  // POST /v1/ops/config/set — write a single key/value to `.env` + process.env.
  // Tier-3 elevation is required for secret fields. Cold fields return 409.
  app.post<{ Body: unknown }>('/v1/ops/config/set', async (request, reply) => {
    const schema = envSchema.partial();
    const body = request.body as { key?: unknown; value?: unknown } | undefined;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    const value = typeof body?.value === 'string' ? body.value : null;
    if (!key) {
      return reply.status(400).send({ ok: false, error: 'key is required' });
    }
    if (value === null) {
      return reply.status(400).send({ ok: false, error: 'value must be a string' });
    }
    if (value.includes('\n') || value.includes('\r')) {
      return reply.status(400).send({
        ok: false,
        error: 'value must not contain newline characters',
        key,
      });
    }
    if (requiresRestart(key)) {
      writeSecurityAudit({
        action: 'config.set',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/ops/config/set',
        details: { key, reason: 'cold_field' },
      });
      return reply.status(409).send({
        ok: false,
        error: 'cold field — restart required',
        key,
        tier: classifyField(key),
      });
    }
    if (requiresElevatedTier(key)) {
      writeSecurityAudit({
        action: 'config.set',
        status: 'blocked',
        ip: request.ip,
        route: '/v1/ops/config/set',
        details: { key, reason: 'tier3_required' },
      });
      return reply.status(403).send({
        ok: false,
        error: 'secret field — tier-3 elevation required',
        key,
        tier: classifyField(key),
      });
    }
    const candidate = { ...process.env, [key]: value };
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.includes(key));
      return reply.status(400).send({
        ok: false,
        error: `validation failed: ${issue?.message ?? 'invalid value'}`,
        key,
      });
    }
    setDotEnvValues({ [key]: value }, process.env);
    process.env[key] = value;
    writeSecurityAudit({
      action: 'config.set',
      status: 'allowed',
      ip: request.ip,
      route: '/v1/ops/config/set',
      details: { key, tier: classifyField(key) },
    });
    return {
      ok: true,
      key,
      tier: classifyField(key),
      newValue: redactFieldValue(key, value),
    };
  });

  // POST /v1/ops/restart — tier-3 gated self-restart.
  // Codex P1 (Round 2): HTTP has no tier-3 session elevation flow, so the
  // endpoint requires the operator passphrase in the request body. The
  // MEMPHIS_API_TOKEN gate (see auth-policy) guards who can CALL the
  // endpoint at all; the passphrase is the second factor that authorizes
  // the actual destructive action.
  app.post('/v1/ops/restart', async (request, reply) => {
    const body = (request.body ?? {}) as {
      reason?: unknown;
      passphrase?: unknown;
    };
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;

    const { requestRestart } = await import('../../runtime/self-restart.js');
    const { validateOperatorPassphrase, loadOperatorConfig } =
      await import('../../auth/operator-gate.js');

    let alreadyElevated: boolean;
    let elevatedVia: string;
    if (loadOperatorConfig(process.env)) {
      if (!passphrase) {
        return reply.status(403).send({
          ok: false,
          reason: 'not-elevated' as const,
          message:
            'restart refused — operator passphrase required in request body as `passphrase` field.',
        });
      }
      // Codex P2 (Round 4): validateOperatorPassphrase throws on the
      // attempt rate-limit. Catch so brute-force doesn't surface as a 500.
      try {
        if (!validateOperatorPassphrase(passphrase, process.env)) {
          return reply.status(403).send({
            ok: false,
            reason: 'not-elevated' as const,
            message: 'restart refused — operator passphrase did not validate.',
          });
        }
      } catch (err) {
        return reply.status(403).send({
          ok: false,
          reason: 'not-elevated' as const,
          message: `restart refused — ${err instanceof Error ? err.message : 'passphrase check failed'}`,
        });
      }
      alreadyElevated = true;
      elevatedVia = 'http-passphrase-body';
    } else {
      // Codex P2 (Round 4): first-run — no operator config set yet. HTTP
      // has no session-minting flow, so mark the call as pre-validated.
      // Access is still gated by MEMPHIS_API_TOKEN (see auth-policy).
      alreadyElevated = true;
      elevatedVia = 'http-first-run-no-config';
    }

    const outcome = await requestRestart({
      surface: 'http',
      actorId: request.ip ?? 'unknown',
      reason,
      alreadyElevated,
      elevatedVia,
    });
    if (!outcome.ok) {
      const status = outcome.reason === 'not-elevated' ? 403 : 409;
      return reply.status(status).send(outcome);
    }
    return outcome;
  });

  app.post('/v1/ops/config/reload', async (request, reply) => {
    const result = await performHotReload();
    writeSecurityAudit({
      action: 'config.reload',
      status: result.ok ? 'allowed' : 'blocked',
      ip: request.ip,
      route: '/v1/ops/config/reload',
      details: {
        applied: result.appliedCount,
        rejectedCold: result.rejectedCold,
        validationError: result.validationError,
        envPath: result.envPath,
      },
    });
    if (!result.ok) {
      if (result.validationError) {
        return reply.status(400).send({
          ok: false,
          error: result.validationError,
          result,
        });
      }
      return reply.status(409).send({
        ok: false,
        error: 'reload blocked — restart required for cold fields',
        coldFields: result.rejectedCold,
        result,
      });
    }
    return { ok: true, result };
  });
}
