type RouteRequest = { body?: unknown; query?: unknown };
type RouteReply = {
  code: (status: number) => RouteReply;
  send: (payload: unknown) => unknown;
};
type RouteApp = {
  get: (path: string, handler: (request: RouteRequest) => Promise<unknown>) => unknown;
  post: (
    path: string,
    handler: (request: RouteRequest, reply: RouteReply) => Promise<unknown>,
  ) => unknown;
};

async function listTier3SessionsHandler() {
  const { listActiveTier3Sessions } = await import('../../../security/tier3-session.js');
  const now = Date.now();
  const sessions = listActiveTier3Sessions(process.env).map((session) => ({
    surface: session.surface,
    actorId: session.actorId,
    grantedAt: new Date(session.grantedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    remainingMs: Math.max(0, session.expiresAt - now),
  }));
  return { ok: true, count: sessions.length, sessions, asOf: new Date(now).toISOString() };
}

export function registerTierCapabilityRoutes(app: RouteApp): void {
  app.get('/v1/ops/tier3/sessions', listTier3SessionsHandler);

  app.post('/v1/ops/tier3/elevate', async (request, reply) => {
    const { requestTier3Elevation } = await import('../../../security/tier3-session.js');
    const body = (request.body ?? {}) as {
      surface?: string;
      actorId?: string;
      passphrase?: string;
    };
    const validSurfaces = ['tui', 'telegram', 'http', 'cli'] as const;
    if (
      typeof body.surface !== 'string' ||
      typeof body.actorId !== 'string' ||
      typeof body.passphrase !== 'string' ||
      !(validSurfaces as readonly string[]).includes(body.surface)
    ) {
      return reply.code(400).send({
        ok: false,
        error:
          'tier3 elevate requires { surface ∈ tui|telegram|matrix|http|cli, actorId, passphrase }',
      });
    }
    const result = requestTier3Elevation({
      surface: body.surface as (typeof validSurfaces)[number],
      actorId: body.actorId,
      passphrase: body.passphrase,
      rawEnv: process.env,
    });
    if (!result.ok) {
      return reply.code(403).send({ ok: false, reason: result.reason, error: result.message });
    }
    return {
      ok: true,
      tier: 3,
      session: {
        surface: result.session.surface,
        actorId: result.session.actorId,
        grantedAt: new Date(result.session.grantedAt).toISOString(),
        expiresAt: new Date(result.session.expiresAt).toISOString(),
      },
    };
  });

  app.get('/v1/ops/capabilities', async (request) => {
    const { runMemphisSelfDescribe } = await import('../../../mcp/tools/self-describe.js');
    const query = request.query as { surface?: string; actorId?: string } | undefined;
    return runMemphisSelfDescribe(
      { surface: query?.surface, actorId: query?.actorId },
      process.env,
    );
  });
}
