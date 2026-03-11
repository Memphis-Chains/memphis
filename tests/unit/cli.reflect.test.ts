import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI reflect', () => {
  it('runs daily reflection and returns 6 reflections', () => {
    const out = execSync('DEFAULT_PROVIDER=local-fallback npx tsx src/infra/cli/index.ts reflect --json', {
      encoding: 'utf8',
    });

    const data = JSON.parse(out);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('reflect');
    expect(data.count).toBe(6);
    expect(Array.isArray(data.reflections)).toBe(true);
  });
});
