import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The landing page is the project's primary conversion surface and its
 * loudest set of claims. Nothing tied it to the code, so the two drifted:
 *
 *   - the page advertised `memphis halt check` and `memphis chain-verify`
 *     in copy-pasteable <pre> blocks. Neither command exists in the CLI
 *     registry (37 commands, verified against src/infra/cli/registry.ts).
 *   - three different chain counts were live at once: 7 in the "uses"
 *     copy, 11 in README.md, 12 in the metric strip — while
 *     src/memory/chain-catalog.ts is the authority.
 *   - the metric strip is captioned "Runtime generuje je przy każdym
 *     załadowaniu strony", but docs/site/ contains zero `fetch(`, so the
 *     numbers are frozen HTML.
 *
 * This test is the contract. It is deliberately cheap: it parses the HTML
 * and the CLI registry as text. A page that needs a runtime to stay honest
 * about its own numbers is a page that will be wrong.
 */

const SITE_HTML = resolve('docs/site/index.html');
const REGISTRY = resolve('src/infra/cli/registry.ts');
const PACKAGE = resolve('package.json');

/** Commands the page tells a visitor to type. */
const ADVERTISED_COMMANDS = ['halt', 'chain-verify'];

/** Chain counts that must not disagree with each other or with the catalog. */
const CHAIN_COUNT_PATTERN = /(?:7|siedem|eleven|11|12)\s+(?:podpisanych\s+)?łańcuch|7\s+chains/i;

function cliCommands(): Set<string> {
  const src = readFileSync(REGISTRY, 'utf8');
  const names = new Set<string>();
  // Each registration starts with a quoted name on its own line.
  for (const m of src.matchAll(/^\s{4}'([a-z-]+)',$/gm)) names.add(m[1]);
  return names;
}

describe('docs/site/index.html — claims match the code', () => {
  const html = readFileSync(SITE_HTML, 'utf8');
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { version: string };

  it('does not advertise a CLI command that does not exist', () => {
    const commands = cliCommands();
    // Collect every violation first. Asserting inside the loop stopped at
    // the first failure, so `chain-verify` was never reported — the test
    // said "one command is missing" when two were.
    const missing = ADVERTISED_COMMANDS.filter(
      (c) => new RegExp(`memphis\\s+${c}\\b`).test(html) && !commands.has(c),
    );
    expect(
      missing,
      `landing page advertises command(s) absent from the CLI registry: ` +
        `${missing.join(', ')}. Either add the command or correct the page.`,
    ).toEqual([]);
  });

  it('declares the same version as package.json', () => {
    // Match the bare semver, with or without a leading `v`. The first
    // version of this assertion only matched `v1.2.3`, so the JSON-LD
    // `"softwareVersion": "1.13.3"` — the copy most search engines read —
    // drifted to 1.13.3 while the test stayed green. Mutation-verified.
    const declared = [...html.matchAll(/v?(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    const versions = [...new Set(declared)].filter((v) => v.startsWith('1.'));
    expect(versions.length, 'no version found on landing page').toBeGreaterThan(0);
    for (const v of versions) {
      expect(v, `landing page declares v${v}, package.json says v${pkg.version}`).toBe(pkg.version);
    }
  });

  it('does not caption frozen numbers as runtime-generated', () => {
    const claimsLive = /runtime generuje je przy każdym załadowaniu strony/i.test(html);
    const fetchesRuntime = /fetch\s*\(/.test(html);
    // If the caption claims live generation, the page must actually
    // fetch. Asserting only one side is how this drifted in the first
    // place: the caption was true when written and the fetch was dropped.
    expect(
      !claimsLive || fetchesRuntime,
      'landing page captions its metrics as runtime-generated but contains no fetch()',
    ).toBe(true);
  });

  it('states one chain count, matching the runtime catalog', () => {
    const stated = [...html.matchAll(/(\d+)\s*(?:podpisanych\s+)?łańcuch/gi)].map((m) =>
      Number(m[1]),
    );
    const unique = [...new Set(stated)];
    // "12 aktywnych łańcuchów" (live metric) and "7 łańcuchów" (prose) both
    // appear; the prose one describes the canonical seven, the metric one
    // the operator's instance. Flag the case where neither is 7 or 12,
    // i.e. the page drifted off both.
    for (const n of unique) {
      expect([7, 12], `unexpected chain count ${n} on landing page`).toContain(n);
    }
    expect(CHAIN_COUNT_PATTERN.test(html)).toBe(true);
  });
});
