import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { interpolateTemplateShell, shellQuote } from '../../src/modules/apps/manifest.ts';

/**
 * Regression net for #140. Manifest steps used to interpolate template
 * vars into a string passed to `bash -lc`. If any var value contained
 * shell metacharacters, those metacharacters were interpreted by the
 * shell (injection). Fix: values are single-quoted at interpolation
 * time.
 */

describe('apps/manifest — shellQuote (#140)', () => {
  it('quotes a plain value', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('neutralizes an embedded single quote', () => {
    expect(shellQuote("he'llo")).toBe(`'he'\\''llo'`);
  });

  it('neutralizes shell metacharacters (;, |, &, $, `)', () => {
    const hostile = `; rm -rf /; |cat /etc/passwd; \`whoami\`; $(id)`;
    const quoted = shellQuote(hostile);
    // Round-trip through a real bash invocation via execFileSync (no
    // parent-shell escaping footguns). bash echo must reproduce the
    // input verbatim, proving nothing ran.
    const out = execSync(`echo ${quoted}`, { shell: '/bin/bash' }).toString().trimEnd();
    expect(out).toBe(hostile);
  });
});

describe('apps/manifest — interpolateTemplateShell (#140)', () => {
  it('substitutes variables with shell-safe quoting', () => {
    const out = interpolateTemplateShell('echo ${A} world', { A: 'safe' });
    expect(out).toBe("echo 'safe' world");
  });

  it('neutralizes injection in variable values', () => {
    const hostile = '; touch /tmp/memphis-pwned-marker-zzz';
    const step = interpolateTemplateShell('echo ${HOSTILE}', { HOSTILE: hostile });
    const out = execSync(step, { shell: '/bin/bash' }).toString().trimEnd();
    // Output must literally contain the hostile string — if bash ran it,
    // the output would be empty and /tmp/memphis-pwned-marker-zzz would
    // exist (we don't check the file since that would be racy; the
    // echo-roundtrip is proof enough).
    expect(out).toBe(hostile);
  });

  it('empty var substitutes as empty quoted string', () => {
    const out = interpolateTemplateShell('x=${MISSING}', {});
    expect(out).toBe("x=''");
  });
});
