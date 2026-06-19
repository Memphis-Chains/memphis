import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('bootstrap shutdown lifecycle wiring', () => {
  it('does not install process-lock signal handlers that bypass graceful shutdown', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/bootstrap.ts'), 'utf8');

    expect(source).not.toMatch(/process\.once\(['"]SIGTERM['"]/);
    expect(source).not.toMatch(/process\.once\(['"]SIGINT['"]/);
    expect(source).toContain("name: 'process-lock'");
    expect(source).toContain('installShutdownHandlers');
  });

  it('keeps the strict Rust bridge startup gate wired into bootstrap', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/bootstrap.ts'), 'utf8');

    expect(source).toContain('assessRustBridgeManifestStatus(process.env)');
    expect(source).toContain('rustBridgeManifest.strictRequired');
    expect(source).toContain('Run npm run build:rust, then restart Memphis');
  });
});
