/**
 * Structural assertions for docs/operator/VAULT-RECOVERY-RUNBOOK.md.
 *
 * Doc rot is real: H2 sections get renamed, fenced code blocks lose their
 * language tag, TODO markers ship to operators. This test pins the load-
 * bearing parts of the runbook so the markdown can evolve in style but
 * not in structure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const RUNBOOK_PATH = resolve(
  process.cwd(),
  'docs/operator/VAULT-RECOVERY-RUNBOOK.md',
);
const INDEX_PATH = resolve(process.cwd(), 'docs/operator/RUNBOOK.md');

describe('VAULT-RECOVERY-RUNBOOK.md', () => {
  it('exists at the canonical path', () => {
    expect(existsSync(RUNBOOK_PATH)).toBe(true);
  });

  const body = existsSync(RUNBOOK_PATH) ? readFileSync(RUNBOOK_PATH, 'utf-8') : '';

  it('declares the five load-bearing H2 sections', () => {
    // Numbered H2 sections per OPERATIONS-MANUAL.md house style.
    const required = [
      '## 1) Symptoms',
      '## 2) Pre-flight',
      '## 3) Recovery paths',
      '## 4) Verification',
      '## 5) Prevention',
    ];
    for (const heading of required) {
      expect(body, `missing section "${heading}"`).toContain(heading);
    }
  });

  it('includes all three recovery sub-procedures (A/B/C)', () => {
    expect(body).toMatch(/### A\) Plain-text bypass/);
    expect(body).toMatch(/### B\) Vault-state rollback/);
    expect(body).toMatch(/### C\) Clean re-init/);
  });

  it('tags every fenced code block with a language', () => {
    // Catch ``` blocks without a language identifier — these render
    // without syntax highlighting + lose semantic intent on copy-paste.
    // Split on the fence marker: odd-indexed segments are code-block
    // bodies; their first line is the opening-fence language tag.
    // (split eats only the leading "```", not the trailing one.)
    const segments = body.split(/^```/m);
    expect(segments.length, 'no fenced code blocks found').toBeGreaterThan(1);
    const untagged: string[] = [];
    for (let i = 1; i < segments.length; i += 2) {
      const firstLine = segments[i].split('\n', 1)[0];
      if (!/^[a-zA-Z0-9_-]+$/.test(firstLine.trim())) {
        untagged.push(firstLine);
      }
    }
    expect(untagged, `untagged opening fences: ${JSON.stringify(untagged)}`).toHaveLength(0);
  });

  it('has no placeholder markers shipped to operators', () => {
    // No <TODO>, no xxx, no TBD, no <FIXME>. Operator copy must be final.
    expect(body).not.toMatch(/<TODO>/i);
    expect(body).not.toMatch(/\bTBD\b/);
    expect(body).not.toMatch(/<FIXME>/i);
  });

  it('flags destructive operations with an Important callout', () => {
    // Path C wipes vault entries — that section must warn.
    const callouts = body.match(/^> \*\*Important:\*\*/gm) ?? [];
    expect(callouts.length, 'at least 3 Important callouts (pre-flight + 2 destructive paths)').toBeGreaterThanOrEqual(3);
  });

  it('cross-references the post-incident gap analysis', () => {
    // The roadmap doc is the source-of-truth for the three recovery paths.
    expect(body).toMatch(/2026-05-11-post-autonomy-todo-and-gap\.md/);
  });
});

describe('RUNBOOK.md index', () => {
  const indexBody = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf-8') : '';

  it('links to VAULT-RECOVERY-RUNBOOK.md from the index table', () => {
    expect(indexBody).toMatch(/VAULT-RECOVERY-RUNBOOK\.md/);
  });
});
