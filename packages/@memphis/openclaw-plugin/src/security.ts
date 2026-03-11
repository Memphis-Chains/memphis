import { appendFileSync } from 'node:fs';
import { normalize } from 'node:path';
import { normalizeToNfc, trimAndNormalizeToNfc } from './unicode-normalizer.js';

const MAX_INPUT_LENGTH = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 100;

const INJECTION_PATTERNS: RegExp[] = [
  /<\s*script\b/i,
  /\b(union\s+select|drop\s+table|insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i,
  /\b(exec\(|system\(|eval\()\b/i,
  /\$\{.*\}/,
  /\|\s*(sh|bash|zsh|powershell|cmd)\b/i,
  /;\s*--/,
];

export class SecurityManager {
  private readonly requestTimestamps = new Map<string, number[]>();

  constructor(private readonly auditLogPath?: string) {}

  validateInput(query: string): boolean {
    const trimmed = trimAndNormalizeToNfc(query);
    if (!trimmed || trimmed.length > MAX_INPUT_LENGTH) return false;
    if (/\0/.test(trimmed)) return false;

    return !INJECTION_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  checkRateLimit(userId: string): boolean {
    const key = trimAndNormalizeToNfc(userId) || 'anonymous';
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    const existing = this.requestTimestamps.get(key) ?? [];
    const fresh = existing.filter((ts) => ts >= windowStart);

    if (fresh.length >= RATE_LIMIT_MAX_REQUESTS) {
      this.requestTimestamps.set(key, fresh);
      return false;
    }

    fresh.push(now);
    this.requestTimestamps.set(key, fresh);
    return true;
  }

  sanitizePath(path: string): string {
    const pathInput = trimAndNormalizeToNfc(path);
    if (!pathInput) {
      throw new Error('Invalid path');
    }

    const normalized = normalize(pathInput).replace(/\\/g, '/');

    if (normalized.includes('..') || normalized.includes('\0')) {
      throw new Error('Path traversal detected');
    }

    if (!normalized.startsWith('/api/')) {
      throw new Error('Path outside allowed API scope');
    }

    return normalized;
  }

  logAudit(event: string, metadata: any): void {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event: normalizeToNfc(event),
      metadata,
    });

    if (!this.auditLogPath) {
      // fallback to stderr so there is always an audit trail in process logs
      console.warn(`[memphis-security] ${entry}`);
      return;
    }

    appendFileSync(this.auditLogPath, `${entry}\n`, { encoding: 'utf8' });
  }
}
