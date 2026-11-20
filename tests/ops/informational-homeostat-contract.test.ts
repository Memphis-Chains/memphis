import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The informational homeostat has to be WIRED, not merely present.
 *
 * A module with a decision function and no caller is a description of a
 * homeostat, not a homeostat: the failing SLO still produces a line in a
 * message to the operator and nothing else. This contract reads the
 * executable lines of the runtime watch and asks whether the decision is
 * taken there, whether the decision is run, and whether the work the
 * runtime shed comes back when it recovers.
 *
 * The executable lines only. The comments in these files explain the
 * fix, and they name the very functions the contract asks about — a gate
 * that reads its own documentation is a gate that cannot fail.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

function executableLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const watch = executableLines(
  readFileSync(path.join(repoRoot, 'src', 'infra', 'runtime', 'scheduler-builtins.ts'), 'utf8'),
);
const homeostat = executableLines(
  readFileSync(
    path.join(repoRoot, 'src', 'infra', 'runtime', 'informational-homeostat.ts'),
    'utf8',
  ),
);

describe('the informational homeostat contract', () => {
  it('is wired into the runtime watch', () => {
    expect(watch).toContain('decideInformationalHomeostat(');
    expect(watch).toContain('runInformationalHomeostat(');
  });

  it('weighs the gated SLOs, not every metric the report carries', () => {
    expect(watch).toContain('assessGatedSlos(');
  });

  it('restores the work it shed when the runtime recovers', () => {
    expect(watch).toContain('restoreOptionalBackgroundWork(');
    expect(watch).toContain('shedTaskIds');
  });

  it('never restarts the runtime on its own', () => {
    expect(homeostat).not.toContain('requestRestart');
    expect(homeostat).not.toContain('process.exit');
  });

  it('acts only on a failure that is happening right now', () => {
    expect(homeostat).toContain('activityStatusBySlo');
    expect(homeostat).toContain('maxEvidenceAgeMs');
  });
});
