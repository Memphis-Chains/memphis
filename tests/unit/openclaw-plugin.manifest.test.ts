import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('openclaw plugin package identity', () => {
  it('keeps manifest and package names aligned', () => {
    const pkg = JSON.parse(
      readFileSync('packages/@memphis/openclaw-plugin/package.json', 'utf8'),
    ) as { name: string };
    const manifest = JSON.parse(
      readFileSync('packages/@memphis/openclaw-plugin/openclaw.plugin.json', 'utf8'),
    ) as { id: string };
    const legacyPkg = JSON.parse(readFileSync('openclaw-plugin/package.json', 'utf8')) as {
      name: string;
    };

    expect(pkg.name).toBe('@memphis/openclaw-plugin');
    // Manifest ID matches the registered memory provider name (not package name)
    expect(manifest.id).toBe('memphis');
    expect(legacyPkg.name).toBe('@memphis/openclaw-plugin');
  });
});
