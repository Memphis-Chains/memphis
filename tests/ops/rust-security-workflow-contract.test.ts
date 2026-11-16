/**
 * The Rust CVE scan has to actually run.
 *
 * THE MEASURED GAP
 * ----------------
 * `scripts/rust-core-safety-check.sh` ran `cargo audit`, and NO workflow
 * invoked it. Measured 2026-11-10: grep over `.github/workflows/`
 * returned no reference, and `npm run ops:rust-core:safety` was a command
 * nobody ran. The runtime audit named it: "cargo audit: the script exists,
 * no workflow invokes it".
 *
 * "Exists but is never called" is the third option, and it was the one in
 * force: a security script whose failure nobody can observe.
 *
 * THE CONTRACT
 * ------------
 * A workflow calls the scanner, and the scanner refuses to pass when the
 * scanner itself is missing. A missing scanner is not a clean tree —
 * that is the same shape as a backup that reports success while the
 * checksum is absent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOW = resolve('.github/workflows/rust-security.yml');
const SCRIPT = resolve('scripts/cargo-audit-check.sh');

/**
 * The lines of a file that a shell or a workflow EXECUTES.
 *
 * A file may describe a behaviour in a comment and not have it — and a
 * contract that reads the description as the behaviour tests the
 * documentation. The same rule the runtime audit applies to the gates it
 * measures.
 */
function executableLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    })
    .join('\n');
}

describe('rust security workflow · it runs the scanner', () => {
  it('exists', () => {
    expect(readFileSync(WORKFLOW, 'utf8')).toBeTruthy();
  });

  it('calls the scanner script in a step that runs', () => {
    const commands = executableLines(readFileSync(WORKFLOW, 'utf8'));
    expect(commands).toContain('scripts/cargo-audit-check.sh');
  });

  it('runs on pull requests, not only on pushes to main', () => {
    // A scan that runs only after the merge has happened cannot stop the
    // merge; it can only report it afterwards.
    const text = readFileSync(WORKFLOW, 'utf8');
    expect(text).toContain('pull_request');
  });

  it('installs cargo-audit rather than assuming it is there', () => {
    const commands = executableLines(readFileSync(WORKFLOW, 'utf8'));
    expect(commands).toMatch(/cargo install cargo-audit/);
  });

  it('does not read the repository permissions beyond what it needs', () => {
    const text = readFileSync(WORKFLOW, 'utf8');
    expect(text).toContain('contents: read');
  });
});

describe('cargo-audit-check.sh · the script the workflow calls', () => {
  it('refuses to pass when cargo-audit is not installed', () => {
    // A scanner that is not installed is not a clean tree. The script
    // must SAY that rather than report OK.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('command -v cargo-audit');
    expect(script).toContain('exit 127');
    expect(script).toContain('not installed');
  });

  it('treats an empty audit report as a failure, not as a pass', () => {
    // A silent audit is indistinguishable from a passing one.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('produced no output');
    expect(script).toContain('treating as failure');
  });

  it('rejects an allowlist entry without a reason', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('without a reason');
  });

  it('holds the allowlist in ONE place — the script, not the workflow', () => {
    // The rustsec/audit-check action would put the accepted advisory IDs
    // in YAML, which is a second place where an exception can be
    // written down and not in the other.
    //
    // The EXECUTED lines decide, not the whole file: this workflow's
    // header explains why the action was NOT used, and that explanation
    // names the action. A test that read the whole file would fail on
    // the documentation of the thing it is checking — the same trap
    // this repository has already paid for twice.
    const commands = executableLines(readFileSync(WORKFLOW, 'utf8'));
    expect(commands).not.toContain('rustsec/audit-check');
    expect(commands).not.toMatch(/^\s*ignore:/m);
  });
});
