/**
 * Security-event block shape — regression for the 2026-09-29 stall.
 *
 * `src/onboarding/first-run.ts:232-241` classifies a chain block as
 * `legacy-migrateable` unless `data.type` is a non-empty string,
 * `data.content` is a string, and `data.tags` is a string[]. Blocks that
 * fail this check flip `runtimeStatus` to `unhealthy` and block `init`
 * until someone runs `memphis repair runtime --force`.
 *
 * `emitRuntimeSecurityEvent` wrote `action` / `status` / `details` /
 * `tags` but NOT `content` — so every redacted prompt-output event
 * pinned the runtime. Two such blocks accumulated (system/007547,
 * system/007617) before anyone noticed.
 *
 * The check below is the same predicate the runtime uses, applied to
 * the payload the emitter builds. If a future refactor drops `content`
 * again, this fails.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSecurityEventBlock,
  assertSecurityEventBlockShape,
} from '../../src/security/runtime-security-events.js';

const VALID_TAGS = (tags: unknown): tags is string[] =>
  Array.isArray(tags) && tags.every((v) => typeof v === 'string');

/** Mirror of src/onboarding/first-run.ts:232-241. */
function classifyAsLegacy(data: Record<string, unknown>): boolean {
  const typeOk = typeof data.type === 'string' && data.type.trim().length > 0;
  const contentOk = typeof data.content === 'string';
  const tags = VALID_TAGS(data.tags);
  return !typeOk || !contentOk || !tags;
}

describe('security event block shape', () => {
  const event = {
    action: 'prompt.output.redacted',
    status: 'blocked',
    details: { surface: 'rust-tui', flags: ['api_token_leak'], contentHash: 'abc123' },
  };

  it('produces a block the onboarding classifier accepts', () => {
    const block = buildSecurityEventBlock(event);
    expect(classifyAsLegacy(block)).toBe(false);
  });

  it('carries a non-empty content string', () => {
    const block = buildSecurityEventBlock(event);
    expect(typeof block.content).toBe('string');
    expect((block.content as string).length).toBeGreaterThan(0);
  });

  it('content is valid JSON that round-trips the event fields', () => {
    const block = buildSecurityEventBlock(event);
    const parsed = JSON.parse(block.content as string);
    expect(parsed.action).toBe('prompt.output.redacted');
    expect(parsed.status).toBe('blocked');
    expect(parsed.details.contentHash).toBe('abc123');
  });

  it('never includes raw prompt text — only the pre-computed hash', () => {
    const block = buildSecurityEventBlock({
      ...event,
      details: { ...event.details, raw: 'MYSECRET_PROMPT_TEXT' },
    });
    // A raw field could ride along if a caller passes one; the block
    // body must not be a dumping ground.
    expect(String(block.content)).not.toContain('raw');
  });

  it('tags are a string array with the security marker', () => {
    const block = buildSecurityEventBlock(event);
    expect(VALID_TAGS(block.tags)).toBe(true);
    expect(block.tags).toContain('security');
  });

  it('type is the Rust-valid system_event variant', () => {
    // 'security_event' is NOT in the Rust block_types enum — using it
    // makes every append silently fail schema validation.
    expect(buildSecurityEventBlock(event).type).toBe('system_event');
  });

  it('assertSecurityEventBlockShape throws on a legacy-shaped block', () => {
    const broken = { type: 'system_event', action: 'x', status: 'blocked', tags: ['security'] };
    expect(() => assertSecurityEventBlockShape(broken as never)).toThrow();
  });
});
