import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';

// Evidence is an operator-reviewed attestation, not a proof of reviewer identity.
export function hasCompletedExternalAudit(root) {
  try {
    const report = readFileSync(join(root, 'docs/security/AUDIT-2026-Q2.md'));
    const evidence = JSON.parse(
      readFileSync(join(root, 'docs/security/AUDIT-2026-Q2.evidence.json'), 'utf8'),
    );
    return (
      report.length > 0 &&
      evidence.reviewType === 'external' &&
      evidence.status === 'completed' &&
      typeof evidence.reviewer === 'string' &&
      evidence.reviewer.trim().length > 0 &&
      Number.isFinite(Date.parse(evidence.completedAt)) &&
      Date.parse(evidence.completedAt) <= Date.now() &&
      typeof evidence.source === 'string' &&
      new URL(evidence.source).protocol === 'https:' &&
      evidence.reportSha256 === createHash('sha256').update(report).digest('hex')
    );
  } catch {
    return false;
  }
}
