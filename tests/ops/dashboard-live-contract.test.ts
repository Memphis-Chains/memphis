/**
 * The dashboard must describe the CURRENT state, not a frozen session.
 *
 * Measured 2026-10-29: `~/public/sites-discovery/dashboard/index.html` was a
 * hand-written snapshot of the 2026-09-07 session. Its headline numbers
 * ("17 zapisanych decyzji", "~8h", "3 HTML artifacts") were typed into the
 * markup, so the page kept reporting a session that had ended seven weeks
 * earlier — and kept listing the `/szczepan` deploy as pending when that
 * path had already been retired from production.
 *
 * Two contracts hold here:
 *
 *  1. The page is GENERATED. No hand-written metric survives a build.
 *  2. The generator reads real data. The numbers on the page are the
 *     numbers in the chain directory right now.
 *
 * The probe list is a third contract, and it is the one that produced the
 * false alarms: the dashboard probed `dsmxshop.com/szczepan/`, `/usa/`,
 * `/extra/`, `/bonus/` — all 404 since mid-September — and rendered each as
 * an error. A probe of a deleted path is not a measurement.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..');
const REPORT = join(REPO, 'scripts', 'dashboard_report.py');
const PROBES = join(REPO, 'scripts', 'dashboard_probes.py');

let workspace: string;
let generated: string;

function runPython(args: string[]): string {
  return execFileSync('python3', args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'memphis-dashboard-'));
  generated = join(workspace, 'index.html');
  runPython([REPORT, generated]);
  runPython([REPORT, join(workspace, 'client.html'), '--audience', 'client']);
}, 180_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe('dashboard generation', () => {
  it('produces a dashboard file', () => {
    expect(existsSync(generated)).toBe(true);
    expect(readFileSync(generated, 'utf8')).toContain('<!doctype html>');
  });

  it('carries no number that was typed by hand', () => {
    const html = readFileSync(generated, 'utf8');
    // These were the frozen snapshot's headline metrics. If any of them
    // reappears, the page is a hand-written document again.
    for (const stale of [
      'Zapisanych decyzji',
      'Czas sesji',
      'Deliverables (.md)',
      'HTML artifacts',
      'Sesja 2026-09-07',
    ]) {
      expect(html).not.toContain(stale);
    }
  });

  it('shows the decision count the chain actually holds', () => {
    const html = readFileSync(generated, 'utf8');
    const decisionsDir = '/home/memphis/.memphis/chains/decisions';
    if (!existsSync(decisionsDir)) return; // no chain on this box

    // Count the chain the same way the generator does, and compare. A
    // "is it greater than zero" assertion would happily accept a
    // hardcoded 17 — the first version of this test did exactly that,
    // and the mutation proved it.
    const onDisk = readdirSync(decisionsDir).filter((name) => name.endsWith('.json')).length;
    const rendered = html.match(
      /<span class="v">(\d+)<\/span><span class="l">Decyzji w łańcuchu/,
    )?.[1];
    expect(rendered).toBeDefined();
    expect(Number(rendered)).toBe(onDisk);
  });

  it('shows the journal count the chain actually holds', () => {
    const html = readFileSync(generated, 'utf8');
    const journalDir = '/home/memphis/.memphis/chains/journal';
    if (!existsSync(journalDir)) return;
    const onDisk = readdirSync(journalDir).filter((name) => name.endsWith('.json')).length;
    const rendered = html.match(
      /<span class="v">(\d+)<\/span><span class="l">Wpisów w journalu/,
    )?.[1];
    expect(rendered).toBeDefined();
    expect(Number(rendered)).toBe(onDisk);
  });

  it('renders the newest decisions from the chain, not from memory', () => {
    const html = readFileSync(generated, 'utf8');
    expect(html).toContain('Ostatnie decyzje');
    // The chain's newest decision title must appear verbatim.
    const newest = execFileSync(
      'bash',
      ['-lc', 'ls -1 /home/memphis/.memphis/chains/decisions/*.json | tail -1'],
      {
        encoding: 'utf8',
      },
    ).trim();
    if (!newest) return;
    const block = JSON.parse(readFileSync(newest, 'utf8')) as { data?: { title?: string } };
    const title = (block.data?.title ?? '').trim();
    if (!title) return;
    const escaped = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    expect(html).toContain(escaped);
  });

  it('renders prices in dollars, not in minor units', () => {
    const html = readFileSync(generated, 'utf8');
    // WooCommerce's store API returns "31640" with currency_minor_unit: 2
    // — that is $316.40. Showing "31640 USD" is a price 100x too high,
    // printed on a page a client reads. The raw minor-unit value must
    // never appear as the price.
    expect(html).not.toMatch(/<td>\$?31640(\s|<\/td>)/);
    expect(html).not.toMatch(/<td>31640 USD<\/td>/);
    const prices = [...html.matchAll(/<td>\$([\d ]+),(\d{2}) USD<\/td>/g)];
    if (prices.length === 0) return; // store API unreachable in this run
    for (const [, whole, cents] of prices) {
      expect(Number(whole.replace(/ /g, ''))).toBeLessThan(10_000);
      expect(Number(cents)).toBeLessThan(100);
    }
  });

  it('labels retired endpoints as retired, not as errors', () => {
    const html = readFileSync(generated, 'utf8');
    expect(html).toContain('wycofany');
    // A retired path must never be rendered with a red error badge.
    expect(html).not.toMatch(/b-404[^>]*>wycofany</);
  });

  it('states the repository link or says it is pending — never silence', () => {
    const html = readFileSync(generated, 'utf8');
    // Either the link is present, or the page says it is pending. Both
    // are honest; a silent absence is not.
    const hasLink = /<a href='https?:\/\/[^']+'/i.test(html);
    const saysPending = html.includes('link w przygotowaniu');
    expect(hasLink || saysPending).toBe(true);
  });
});

describe('audience split', () => {
  it('keeps runtime counters out of the client view', () => {
    const clientHtml = readFileSync(join(workspace, 'client.html'), 'utf8');
    const internalHtml = readFileSync(generated, 'utf8');
    // The operator's picture of the runtime is not the client's business.
    expect(internalHtml).toContain('Decyzji w łańcuchu');
    expect(clientHtml).not.toContain('Decyzji w łańcuchu');
    expect(clientHtml).not.toContain('Wpisów w journalu');
    // But the shop facts belong to both.
    expect(clientHtml).toContain('Produktów w sklepie');
  });

  it('carries no chain content in the client view', () => {
    const clientHtml = readFileSync(join(workspace, 'client.html'), 'utf8');
    const internalHtml = readFileSync(generated, 'utf8');
    expect(internalHtml).toContain('Ostatnie decyzje');
    // Measured 2026-10-29: filtering the decision log by project
    // keywords still carried the operator's commercial terms inside it
    // — "13% prowizja + 100 PLN/mies flat", "$280 P&L". A status page
    // for a project does not need the operator's side of the deal.
    for (const commercial of ['13%', '100 PLN', '280', 'prowizj', 'P&L', 'Wodzu']) {
      expect(clientHtml).not.toContain(commercial);
    }
    // Other projects' work must not surface either.
    expect(clientHtml).not.toContain('LUMIX');
    expect(clientHtml).not.toContain('Kinocut');
  });
});

describe('probe list', () => {
  it('probes only URLs that exist, and keeps retired ones separate', () => {
    const probes = readFileSync(PROBES, 'utf8');
    expect(probes).toContain('RETIRED_PROBES');
    expect(probes).toContain('https://dsmxshop.com/');
    // The retired PRODUCTION paths must not appear in the live list.
    // The bare path fragment is not enough to assert on: the local
    // artifact `http://localhost:8765/szczepan/` is still served and
    // legitimately lives in the live list.
    const liveSection = probes.slice(
      probes.indexOf('PROBES = ['),
      probes.indexOf('RETIRED_PROBES = ['),
    );
    for (const retired of [
      'https://dsmxshop.com/szczepan/',
      'https://dsmxshop.com/usa/',
      'https://dsmxshop.com/extra/',
      'https://dsmxshop.com/bonus/',
    ]) {
      expect(liveSection).not.toContain(retired);
    }
  });

  it('has exactly one probe list, shared by the seeder and the API', () => {
    for (const file of ['scripts/seed-dashboard-db.py', 'scripts/dashboard-api.py']) {
      const source = readFileSync(join(REPO, file), 'utf8');
      expect(source).toContain('from dashboard_probes import');
      // No second, hand-maintained copy of the list.
      expect(source).not.toMatch(/^PROBES\s*=\s*\[/m);
    }
  });
});
