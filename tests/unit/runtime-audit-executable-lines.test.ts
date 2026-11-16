/**
 * A gate must read what RUNS, not what a file SAYS about itself.
 *
 * THE MEASURED FAILURE
 * --------------------
 * The gate-coverage check asks "does the secret scan exempt tests by
 * path?". The first implementation answered that by grepping the whole
 * file for `tests/*`. The script's own header explains the history of
 * the fix — and the history contains the very pattern the script no
 * longer applies. So the gate reported a hole that had been closed,
 * forever, and the operator could not tell the alarm from the truth.
 *
 * The same shape has bitten this repository before: a gate that reads
 * its own documentation as configuration. The fix is mechanical — drop
 * the commented lines — and this file is what keeps it mechanical.
 */
import { describe, expect, it } from 'vitest';

import { executableLines } from '../../src/infra/audit/runtime-audit.js';

describe('executableLines · only the lines that run', () => {
  it('drops a shell comment', () => {
    const text = ['# this mentions tests/* in passing', 'echo hello'].join('\n');
    expect(executableLines(text)).toBe('echo hello');
  });

  it('drops an indented comment', () => {
    const text = ['    # indented comment about tests/*', 'run=true'].join('\n');
    expect(executableLines(text)).toBe('run=true');
  });

  it('drops blank lines', () => {
    const text = ['', 'echo hello', '', '  ', 'echo bye'].join('\n');
    expect(executableLines(text)).toBe('echo hello\necho bye');
  });

  it('keeps a line that merely CONTAINS a hash', () => {
    // A shell parameter expansion and a URL fragment are not comments.
    // A naive "strip everything after #" would silently remove them.
    const text = ['echo "value=${TOKEN#prefix}"', 'echo "https://x/#frag"'].join('\n');
    expect(executableLines(text)).toContain('${TOKEN#prefix}');
    expect(executableLines(text)).toContain('https://x/#frag');
  });

  it('keeps a YAML step that runs a scanner', () => {
    const text = [
      'jobs:',
      '  cargo-audit:',
      '    steps:',
      '      - run: bash scripts/cargo-audit-check.sh',
    ].join('\n');
    expect(executableLines(text)).toContain('scripts/cargo-audit-check.sh');
  });

  it('drops a YAML comment that names the scanner', () => {
    const text = ['# see scripts/cargo-audit-check.sh for the policy', 'run: echo hi'].join('\n');
    expect(executableLines(text)).not.toContain('cargo-audit-check.sh');
  });

  it('returns an empty string for a file of nothing but comments', () => {
    expect(executableLines('# a\n# b\n')).toBe('');
  });
});
