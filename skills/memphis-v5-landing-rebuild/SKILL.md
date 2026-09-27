# memphis-v5-landing-rebuild

**Skill version:** 0.1.0
**Tier:** 0 (no vault, no passphrase)
**Pattern type:** reference design → implementation → verify → deploy
**Audience:** Memphis agents producing HTML landing pages (memphis-v5.pl and similar)

## Purpose

Build a public-facing HTML landing page for memphis-v5.pl using the **pitch-deck visual vocabulary** (Memphis orange + MiniMax blue + Watra earth, 3-brand integration theme, hero stats grid, two-column comparison, diagram, pricing cards, partnership strip, CTA).

The skill captures the design vocabulary so it is reproducible. Once you have read this skill, you can produce a memphis-v5.pl-grade landing for any sub-product (Watra.ai standalone, MiniMax partnership pitch, Memphis-on-Hetzner, etc.) without rediscovering the design tokens each time.

## When to use

Invoke this skill when:

- Operator asks for "memphis-v5.pl-style" landing for a new product or campaign
- A pitch deck has been approved and needs a public landing-page version
- A sub-brand (Watra.ai, MemphisOS, etc.) needs to keep the visual family
- Pitch deck HTML exists at `~/memphis/docs/pitch/*.html` and you need to derive a single-page site from it

Do NOT invoke this skill for:

- Internal admin docs (`docs/` directory) — different layout
- PDF-only deliverables — go directly to `libreoffice --convert-to pdf`
- Marketing email templates — different format, single-column

## Components

| Component | Path | Purpose |
|---|---|---|
| Skill doc (this file) | `~/memphis/skills/memphis-v5-landing-rebuild/SKILL.md` | reference design tokens + workflow |
| Reference landing | `~/memphis/docs/pitch/memphis-watra-minimax-pitch-deck.html` | visual vocabulary source (12 slides, light mode, pitch-deck canvas) |
| Reference landing (dark) | `~/memphis/docs/pitch/memphis-v5-pl-landing.html` | dark mode adaptation (memphis-v5.pl deploy target) |
| Original site | `/home/memphis/public/sites-discovery/memphis-v5-pl/site_index.html` | previous version to learn from (dark mode, LLM-friendly meta tags) |
| Deploy target | `/home/memphis/public/sites-discovery/memphis-v5-pl/site_index.html` | where the new HTML goes |

## Design tokens (THE MOST IMPORTANT PART)

These are the canonical CSS custom properties for the Memphis × MiniMax × Watra.ai three-brand layout. **All landing pages in this family must use these exact values** unless there is a documented reason to deviate.

```css
:root {
  /* Memphis brand */
  --memphis-orange: #ff6b35;
  --memphis-orange-deep: #c44e1f;
  --memphis-cream: #f4f1ea;
  /* MiniMax brand */
  --minimax-blue: #1a4d8f;
  --minimax-blue-light: #e8f0fa;
  /* Watra.ai brand */
  --watra-earth: #4a3c2a;
  --watra-earth-light: #d6c9b4;
  /* Foundation (dark mode — for memphis-v5.pl public site) */
  --bg: #040509;
  --bg-2: #0a0d14;
  --bg-3: #0f1318;
  --fg: #edf2f7;
  --muted: #97a3b3;
  --line: rgba(255,255,255,0.07);
  --line-2: rgba(255,255,255,0.12);
  --accent-2: #2dd4bf;
  --accent-3: #9ae6d8;
  --good: #22c55e;
  --danger: #ef4444;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
}
```

### Color usage rules

| Element | Color | Token |
|---|---|---|
| Memphis brand elements (logo, primary buttons, headers) | Orange | `--memphis-orange` |
| MiniMax elements (partnership badges, "Powered by" pills, secondary buttons) | Blue | `--minimax-blue` |
| Watra.ai elements (knowledge-pack marketplace cards) | Earth | `--watra-earth` |
| Memphis deep emphasis (hover, focus) | Deep orange | `--memphis-orange-deep` |
| Card backgrounds (dark mode) | Lifted bg | `--bg-2` |
| Card backgrounds (light mode / pitch deck) | White | `--paper` (defined separately) |
| Body text | Light gray | `--fg` (dark) / `--ink` (light) |
| Muted text | Mid gray | `--muted` |
| Dividers, borders | Translucent | `--line` / `--line-2` |

### Typography

- **Sans:** `Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`
- **Mono:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (used in `code` elements only)
- **H1:** `clamp(40px, 7vw, 84px)`, `font-weight: 900`, `letter-spacing: -2pt`
- **H2:** `clamp(28px, 4.5vw, 48px)`, `font-weight: 800`
- **Body:** `font-size: 17px`, `line-height: 1.65`
- **Stat number:** `font-size: 42px`, `font-weight: 900`, `letter-spacing: -1pt`
- **Section PL label:** `font-size: 15px`, `text-transform: uppercase`, `letter-spacing: 0.5pt`

### Layout primitives

These CSS class names are stable across the family. Re-use them.

| Class | Purpose | When to use |
|---|---|---|
| `.container` | `max-width: 1200px; margin: 0 auto; padding: 0 32px` | All section wrappers |
| `.hero` | `padding: 120px 0 80px` | Hero section only |
| `.hero-badges` | `display: flex; gap: 12px; flex-wrap: wrap` | Brand chips above title |
| `.badge` + `.badge-memphis` + `.badge-minimax` + `.badge-watra` + `.badge-powered` | Brand chips | Top of hero |
| `.stats` | `grid-template-columns: repeat(4, 1fr); gap: 20px` | 4-stat metric grid |
| `.stat` + `.stat.blue` + `.stat.earth` | Top-border colors per brand | Stat cards |
| `.cols-2` | `grid-template-columns: 1fr 1fr; gap: 24px` | Two-column comparison (responsive) |
| `.col` + `.col.blue` + `.col.earth` | Top-border colors per brand | Two-column cards |
| `.chain-grid` | `repeat(7, 1fr); gap: 8px` | Memphis chain grid (7 chips) |
| `.chain-chip` | Chain grid cell with small caption | One chain |
| `.arch-flow` | `repeat(5, 1fr) with arrows` | Architecture diagram (3 boxes + 2 arrows) |
| `.arch-box` + `.arch-box.blue` + `.arch-box.earth` | Diagram boxes | Architecture flow |
| `.arrow` | `font-size: 24px; color: var(--memphis-orange)` | Diagram arrows (⇄) |
| `.pricing-grid` | `repeat(3, 1fr); gap: 20px` | Pricing tiers |
| `.price-card` + `.price-card.featured` | Pricing tier | One tier; .featured adds ribbon + glow |
| `.partnership-strip` | `linear-gradient(135deg, var(--minimax-blue-light), rgba(255,107,53,0.1))` with blue border | Partnership pitch block |
| `.powered` | `background: var(--minimax-blue); color: white` | "POWERED BY MINIMAX" pill |
| `.cta-strip` | Centered, gradient bg, large padding | Final call-to-action |
| `.footer-row` | `display: flex; justify-content: space-between` | Footer layout |

## Page anatomy (canonical section order)

For any landing page in this family, sections appear in this order:

```
1. .hero                    (badges + 3-line title with color-coded keywords + sub + sub-pl + CTAs)
2. .stats                   (4-stat grid: chains/tools/users/stars)
3. ARCHITECTURE             (.section-pl + h2 + .chain-grid + .arch-flow)
4. PROBLEM                  (.section-pl + h2 + .cols-2: "What we solve" / "What we are NOT")
5. WHY PARTNER              (.section-pl + h2 + .cols-2: technology / partnership)
6. SUB-PRODUCT              (.section-pl + h2 + .cols-2: explanation / why this partner)
7. PARTNERSHIP STRIP        (.partnership-strip id="partnership": ask / don't ask)
8. PRICING                  (.section-pl + h2 + .pricing-grid with featured middle card)
9. CTA STRIP                (.cta-strip: install + contact + curl|bash command)
10. FOOTER                  (.footer-row: brand + nav links + powered-by line)
```

**Optional sections** (insert as needed):
- SOCIAL PROOF (.section-pl + h2 + pull quote + metrics) — between WHY PARTNER and SUB-PRODUCT
- TIMELINE (.section-pl + h2 + .timeline grid) — between SUB-PRODUCT and PARTNERSHIP STRIP

## Bilingual pattern (Polish + English)

For Polish customers (default for memphis-v5.pl):

```
.section-pl {
  /* Polish label, uppercase, blue, border-bottom */
  color: var(--minimax-blue);
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  font-weight: 700;
}

.sub-pl {
  /* Polish subtitle after English hero subtitle */
  border-left: 3px solid var(--memphis-orange);
  padding-left: 16px;
  font-size: 16px;
  color: var(--fg);
}

.col li::before {
  /* Polish-style bullet marker */
  content: "▸";
  color: var(--memphis-orange);
}
```

**Polish gloss under metric numbers:**
```html
<div class="stat-num">200M</div>
<div class="stat-label">MiniMax users</div>
<div class="stat-pl">użytkowników M3</div>
```

## Meta tags (preserved from original site)

Always include:
- `<meta charset="utf-8">`
- `<meta name="viewport" content="width=device-width,initial-scale=1">`
- `<title>` (PL + EN mix OK)
- `<meta name="description">` (PL, 1-2 sentences, includes "Apache-2.0" + "no telemetry")
- OpenGraph: `og:title`, `og:description`, `og:type=website`, `og:image`
- `<link rel="alternate" type="text/plain" href="/llms.txt">` (LLM guide)
- `<link rel="agent-manifest" href="/agents.json">` (for AI agents)
- Favicon SVG (Memphis triangle in orange)

## Workflow (how to use this skill)

```
1. Read this SKILL.md                                       (you are here)
2. Read memphis-watra-minimax-pitch-deck.html              (visual vocabulary source)
3. Read memphis-v5-pl-landing.html                        (dark mode deploy target)
4. Confirm scope with operator: which sub-brand, which sections, which CTAs
5. Draft new HTML in ~/memphis/docs/pitch/<name>.html      (workspace — source of truth)
6. Copy to /home/memphis/public/sites-discovery/<name>/     (deploy target)
7. Verify MD5 match
8. Open in browser to confirm render
```

## Convert to PDF (if needed)

```bash
cd ~/memphis/docs/pitch
libreoffice --headless --convert-to pdf memphis-v5-pl-landing.html
```

**Do NOT regenerate the pitch-deck PDF after every edit.** Only convert when you need a printable artifact. The HTML is canonical; PDF is a snapshot.

## Anti-confab

- Do NOT use a different palette. The three-brand color scheme is part of the design family identity.
- Do NOT remove the `POWERED BY MINIMAX` badge. It is the partnership signal and we are NOT hiding it.
- Do NOT add a navigation header. Single-page scrollable narrative only.
- Do NOT use a CTA form (no backend). Use `mailto:` + GitHub links.
- Do NOT replace `.chain-grid` with a flex layout. The 7-cell grid is iconic.

## When design vocabulary changes

If you need to change the palette or layout primitives:

1. Update this SKILL.md FIRST (tokens + anatomy)
2. Then regenerate ALL existing landing pages to match
3. Bump skill version (0.1.0 → 0.2.0)
4. Document the change in decisions chain
5. Notify operator of breaking change

## Related

- `~/memphis/docs/pitch/memphis-watra-minimax-pitch-deck.html` — source of design vocabulary
- `~/memphis/docs/pitch/memphis-v5-pl-landing.html` — dark mode deploy target
- `/home/memphis/public/sites-discovery/memphis-v5-pl/site_index.html` — currently deployed (may need updating)
- `~/memphis/docs/pitch/README.md` — pitch deck catalog
- `~/memphis/docs/partnerships/` — MiniMax outreach materials
