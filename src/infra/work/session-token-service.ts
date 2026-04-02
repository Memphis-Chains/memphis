import { createHmac, timingSafeEqual } from 'node:crypto';

type SessionTokenClaims = {
  sid: string;
  wid: string;
  scope: string[];
  exp: number;
  epoch: number;
};

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64');
}

export class SessionTokenService {
  constructor(private readonly secret: string | undefined) {}

  public isReady(): boolean {
    return typeof this.secret === 'string' && this.secret.trim().length >= 16;
  }

  public issue(input: {
    sessionId: string;
    workerId: string;
    capabilityScope: string[];
    expiresAtMs: number;
    epoch: number;
  }): string {
    if (!this.isReady()) {
      throw new Error('session token secret is not configured');
    }

    const header = { alg: 'HS256', typ: 'MWS' };
    const claims: SessionTokenClaims = {
      sid: input.sessionId,
      wid: input.workerId,
      scope: [...input.capabilityScope],
      exp: input.expiresAtMs,
      epoch: input.epoch,
    };
    const encodedHeader = toBase64Url(JSON.stringify(header));
    const encodedClaims = toBase64Url(JSON.stringify(claims));
    const payload = `${encodedHeader}.${encodedClaims}`;
    const signature = toBase64Url(
      createHmac('sha256', this.secret!.trim()).update(payload).digest(),
    );
    return `${payload}.${signature}`;
  }

  public verify(token: string, nowMs = Date.now()): SessionTokenClaims {
    if (!this.isReady()) {
      throw new Error('session token secret is not configured');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('invalid session token format');
    }

    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) {
      throw new Error('invalid session token format');
    }

    const payload = `${encodedHeader}.${encodedClaims}`;
    const expected = createHmac('sha256', this.secret!.trim()).update(payload).digest();
    const received = fromBase64Url(encodedSignature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('invalid session token signature');
    }

    const claims = JSON.parse(fromBase64Url(encodedClaims).toString('utf8')) as SessionTokenClaims;
    if (!claims || typeof claims !== 'object') {
      throw new Error('invalid session token payload');
    }
    if (typeof claims.sid !== 'string' || typeof claims.wid !== 'string') {
      throw new Error('invalid session token payload');
    }
    if (!Array.isArray(claims.scope) || claims.scope.some((item) => typeof item !== 'string')) {
      throw new Error('invalid session token payload');
    }
    if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.epoch)) {
      throw new Error('invalid session token payload');
    }
    if (claims.exp < nowMs) {
      throw new Error('session token expired');
    }
    return claims;
  }
}
