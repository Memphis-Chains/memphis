import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

// @ts-expect-error Small repository script has no declaration file.
import { hasCompletedExternalAudit } from '../../scripts/q2-audit-evidence.mjs';

it('refuses an internal report, missing evidence, changed report and future attestation', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-q2-audit-evidence-'));
  const directory = join(root, 'docs/security');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'AUDIT-2026-Q2.md'), 'Synthetic internal review.');
  expect(hasCompletedExternalAudit(root)).toBe(false);
  const evidence = {
    reviewType: 'internal',
    status: 'completed',
    reviewer: 'Synthetic',
    completedAt: '2026-01-01',
    source: 'https://example.invalid/review',
    reportSha256: createHash('sha256').update('Synthetic internal review.').digest('hex'),
  };
  const put = () =>
    writeFileSync(join(directory, 'AUDIT-2026-Q2.evidence.json'), JSON.stringify(evidence));
  put();
  expect(hasCompletedExternalAudit(root)).toBe(false);
  evidence.reviewType = 'external';
  evidence.completedAt = '2999-01-01';
  put();
  expect(hasCompletedExternalAudit(root)).toBe(false);
  evidence.completedAt = '2026-01-01';
  put();
  expect(hasCompletedExternalAudit(root)).toBe(true);
  writeFileSync(join(directory, 'AUDIT-2026-Q2.md'), 'Changed content');
  expect(hasCompletedExternalAudit(root)).toBe(false);
});
