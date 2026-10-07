/**
 * Regenerate the landing page's metric strip — and the typed terminal and
 * noscript fallback that quote the same numbers — from the code and the
 * operator's live chains.
 *
 * WHY THIS EXISTS
 * ---------------
 * docs/site/index.html carried four numbers presented as "Liczby z
 * uruchomionej instancji". They were hand-maintained and had drifted: the
 * page said 13 332 blocks while the operator's chains held 15 046, and
 * 57 tools / "łącznie 60" while TOOL_REGISTRY holds 61 with 3 behind the
 * experimental flag. The page captions itself "Dowód · nie obietnica", so
 * stale numbers there are worse than no numbers.
 *
 * The first version of this script only rewrote the metric strip, which left
 * the typed terminal free to drift again — mutating it proved exactly that:
 * `npm run -s ops:sync-site-metrics` "fixed" the block count and silently
 * left the chain count wrong, because the test that caught it was the only
 * thing noticing. All three surfaces are rewritten here.
 *
 * Run: `npm run -s ops:sync-site-metrics`
 * Check: `npm run -s ops:sync-site-metrics -- --check` (exit 1 on drift)
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { TOOL_REGISTRY } from '../src/gateway/tool-registry.js';

const SITE = resolve('docs/site/index.html');

/** Read the version from package.json so the page cannot quote a stale one. */
const VERSION = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string })
  .version;

const registry = TOOL_REGISTRY as Record<string, { featureFlag?: string }>;
const totalTools = Object.keys(registry).length;
const flaggedTools = Object.values(registry).filter((t) => t?.featureFlag).length;
const unflaggedTools = totalTools - flaggedTools;

/**
 * Block and chain counts come from ~/.memphis/chains.
 *
 * CAVEAT: this is the *operator's* private instance, not a public figure.
 * Publishing "15 046 blocks" says something about one machine's usage, which
 * is arguably the kind of telemetry the project declares it does not do. It
 * is kept because the operator asked for real numbers and because a page
 * nobody can regenerate goes stale. If that trade is wrong the fix is to drop
 * these two metrics from the strip, not to freeze them by hand.
 */
function chainCounts(): { blocks: number; chains: number } {
  const dir = join(homedir(), '.memphis', 'chains');
  let blocks = 0;
  let chains = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // `_quarantine` and `*.backup-*` are not active chains.
    if (entry.name.startsWith('_') || entry.name.includes('.backup')) continue;
    chains += 1;
    for (const file of readdirSync(join(dir, entry.name))) {
      if (file.endsWith('.json')) blocks += 1;
    }
  }
  return { blocks, chains };
}

/** Polish thousands separator, matching the page's existing "13 332" style. */
const fmt = (n: number): string => n.toLocaleString('en-US').replace(/,/g, ' ');

/** Replace the first occurrence, and fail loudly if the anchor moved. */
function swap(src: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(src)) throw new Error(`anchor not found: ${what}`);
  return src.replace(pattern, replacement);
}

function render(): { src: string; blocks: number; chains: number } {
  const { blocks, chains } = chainCounts();
  const blockText = fmt(blocks);
  let src = readFileSync(SITE, 'utf8');

  // --- metric strip -------------------------------------------------------
  const strip = (label: string, count: number, text: string): string => {
    const labelIdx = src.indexOf(`>${label}</span>`);
    if (labelIdx === -1) throw new Error(`metric label not found: ${label}`);
    const open = src.lastIndexOf('<span class="metric-num"', labelIdx);
    const openEnd = src.indexOf('>', open) + 1;
    const close = src.indexOf('</span>', openEnd);
    src =
      src.slice(0, open) +
      `<span class="metric-num" data-count="${count}">${text}` +
      src.slice(close);
  };

  strip('bloków w łańcuchach', blocks, blockText);
  strip('narzędzi bez flagi', unflaggedTools, String(unflaggedTools));
  strip('wywołań na zewnątrz', 0, '0');
  strip('aktywnych łańcuchów', chains, String(chains));

  // --- typed terminal -----------------------------------------------------
  src = swap(
    src,
    /<span data-line>chain blocks {4}<span class="t-val">[^<]*<\/span>/,
    `<span data-line>chain blocks    <span class="t-val">${blockText}</span>`,
    'terminal chain blocks',
  );
  src = swap(
    src,
    /<span data-line>chains {10}<span class="t-val">\d+<\/span> active/,
    `<span data-line>chains          <span class="t-val">${chains}</span> active`,
    'terminal active chains',
  );

  // --- noscript fallback --------------------------------------------------
  src = swap(
    src,
    /status ok \(v[\d.]+\) · [\d\s]+ bloków w \d+ łańcuchach/,
    `status ok (v${VERSION}) · ${blockText} bloków w ${chains} łańcuchach`,
    'noscript summary',
  );

  return { src, blocks, chains };
}

const current = readFileSync(SITE, 'utf8');
const { src: next, blocks, chains } = render();

if (next === current) {
  console.log('[sync-site-metrics] up to date');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error('[sync-site-metrics] drift from measured values:');
  for (const l of current.split('\n')) {
    if (next.includes(l)) continue;
    if (l.includes('data-count') || l.includes('t-val') || l.includes('łańcuchach')) {
      console.error(`[sync-site-metrics]   ${l.trim().slice(0, 110)}`);
    }
  }
  console.error('[sync-site-metrics] run: npm run -s ops:sync-site-metrics');
  process.exit(1);
}

writeFileSync(SITE, next, 'utf8');
console.log(
  `[sync-site-metrics] updated (${unflaggedTools}/${totalTools} tools unflagged, ${flaggedTools} flagged, ${blocks} blocks in ${chains} chains)`,
);
