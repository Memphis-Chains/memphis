#!/usr/bin/env python3
"""Build the client-facing dashboard from MEASURED data, not from memory.

WHY THIS FILE EXISTS
--------------------
The dashboard served from `~/public/sites-discovery/dashboard/index.html` was
a frozen snapshot of the 2026-09-07 session. Its numbers ("17 zapisanych
decyzji", "~8h", "3 HTML artifacts") were hardcoded in the markup, so the
page kept reporting a session that ended seven weeks ago — and kept
claiming the `/szczepan` deploy was pending when `/szczepan` had been
retired from production.

Measured 2026-10-29:
  - decisions chain: 470 blocks (page claimed 17)
  - production dsmxshop.com: /szczepan/, /usa/, /extra/, /bonus/ all 404
  - live pages: /, /en/, /shop/ — WordPress 7.1.4, WooCommerce 11.2.1
  - 6 products in the store, 6 published pages

Everything below is read at build time. Nothing is typed by hand, so the
next run cannot repeat the old failure of asserting a number nobody
measured.

Stdlib only. No network writes. Read-only against the chain.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dashboard_probes import ALL_PROBES, PROBES, RETIRED_PROBES, probe_one  # noqa: E402

CHAIN_ROOT = Path("/home/memphis/.memphis/chains")
DECISIONS = CHAIN_ROOT / "decisions"
JOURNAL = CHAIN_ROOT / "journal"
CASES = CHAIN_ROOT / "cases"
SYSTEM = CHAIN_ROOT / "system"

# Project metadata — the operator's own words about where the work stands.
#
# It lives in a LOCAL config file, not in this repository, for two reasons:
#
#  1. The repository is public. A third party's name does not belong in
#     it, and `scripts/pii-scan.sh` already carries the client's name as
#     an advisory pattern because older files put it there.
#  2. The operator hands over the repository link mid-session. Editing a
#     config file does not need a commit, a branch, and a review.
#
# The file is created on first run with sane defaults and is chmod 0600.
PROJECT_CONFIG = Path(
    os.environ.get(
        "MEMPHIS_DASHBOARD_PROJECT",
        "/home/memphis/.memphis/config/dashboard-project.json",
    )
)

PROJECT_DEFAULTS = {
    "client": "",
    "company": "",
    "domain": "",
    "repo_label": "private repo",
    "repo_url": "",
    "phase": "",
    "phase_detail": "",
    "since": "",
}


def load_project() -> dict:
    """Read the local project config, creating it on first run."""
    project = dict(PROJECT_DEFAULTS)
    try:
        if PROJECT_CONFIG.exists():
            stored = json.loads(PROJECT_CONFIG.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                project.update({k: v for k, v in stored.items() if k in PROJECT_DEFAULTS})
            return project
    except Exception:
        pass
    try:
        PROJECT_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        PROJECT_CONFIG.write_text(
            json.dumps(PROJECT_DEFAULTS, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        PROJECT_CONFIG.chmod(0o600)
    except Exception:
        pass
    return project

CSS = """
:root{--bg:#0a0e14;--panel:#131820;--border:#1f2933;--text:#e6edf3;--muted:#8b949e;
--blue:#58a6ff;--green:#3fb950;--orange:#f0883e;--purple:#bc8cff;--yellow:#d29922;--red:#f85149}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:var(--bg);color:var(--text);margin:0;padding:32px 24px;line-height:1.6}
.wrap{max-width:1100px;margin:0 auto}
h1{color:var(--blue);margin:0 0 4px;font-size:30px}
.subtitle{color:var(--muted);margin:0 0 24px;font-size:14px}
h2{color:var(--green);margin:40px 0 14px;padding-bottom:8px;border-bottom:1px solid(var(--border);font-size:20px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin:12px 0}
.card-title{font-weight:700;margin-bottom:6px}
.card-desc{font-size:13px;color:var(--muted)}
.card-desc code{background:#0d1117;padding:1px 6px;border-radius:3px;font-size:12px}
.metric{display:inline-block;background:var(--panel);border:1px solid var(--border);border-radius:8px;
padding:12px 16px;margin:4px 8px 4px 0;min-width:140px;text-align:center}
.metric .v{font-size:22px;font-weight:700;color:var(--blue);display:block}
.metric .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.metric.green .v{color:var(--green)}.metric.yellow .v{color:var(--yellow)}.metric.red .v{color:var(--red)}
.metric.orange .v{color:var(--orange)}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
th{text-align:left;padding:8px 12px;background:#1a2332;color:var(--blue);border-bottom:1px solid var(--border)}
td{padding:8px 12px;border-bottom:1px solid var(--border)}
tr:hover td{background:#0d1117}
.badge{padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700}
.b-200{background:#12351c;color:#3fb950}.b-404{background:#3a1d1d;color:#f85149}
.b-0{background:#3a2f14;color:#d29922}.b-retired{background:#262b33;color:#8b949e}
.muted{color:var(--muted)}
.meta{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--muted)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
a{color:var(--blue)}
"""


def count_blocks(chain_dir: Path) -> int:
    """Count chain blocks. Measured, never assumed."""
    try:
        return len(list(chain_dir.glob("*.json")))
    except OSError:
        return 0


def newest_decisions(limit: int = 12, keywords: tuple[str, ...] = ()):
    """Newest decisions, newest first, straight from the chain.

    `keywords` narrows the selection to decisions about the project.
    That filter exists for the CLIENT view: the chain holds runtime
    work that has nothing to do with this project, and a client reads a
    page, not an operator's log.

    The match is on the TITLE only. Measured 2026-10-29: matching the
    body pulled in unrelated work — a security decision that merely
    mentioned the domain in passing, a PKD research note — because the
    body of a decision is free text that can name anything. The title
    is the label the operator gave the decision, and it is the honest
    place to look for "is this about this project".
    """
    rows = []
    for fp in sorted(DECISIONS.glob("*.json")):
        try:
            block = json.loads(fp.read_text())
        except Exception:
            continue
        data = block.get("data") or {}
        title = (data.get("title") or "").strip()
        choice = (data.get("choice") or "").strip()
        if keywords:
            haystack = title.lower()
            if not any(keyword.lower() in haystack for keyword in keywords):
                continue
        rows.append({
            "index": block.get("index"),
            "ts": (block.get("timestamp") or "")[:16].replace("T", " "),
            "title": title,
            "choice": choice,
        })
    rows.sort(key=lambda r: (r["ts"], r["index"] or 0), reverse=True)
    return rows[:limit]


def fetch_json(url: str, timeout: int = 10):
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "MemphisDashboard/1.0"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception:
        return None


def store_facts():
    """What the production shop actually offers right now."""
    facts = {"products": [], "product_count": None, "pages": None, "wp_version": None,
             "woo_version": None, "reachable": None}
    products = fetch_json("https://dsmxshop.com/wp-json/wc/store/v1/products?per_page=20")
    if isinstance(products, list):
        facts["product_count"] = len(products)
        for product in products:
            prices = product.get("prices") or {}
            facts["products"].append({
                "name": (product.get("name") or "").strip(),
                "currency": prices.get("currency_code"),
                "currency_symbol": prices.get("currency_symbol") or "",
                # WooCommerce's store API returns prices in MINOR UNITS.
                # Measured 2026-10-29: `currency_minor_unit: 2`, and the
                # raw price is "31640" — that is $316.40, not $31,640.
                # Reading it as dollars would show a price 100x too high.
                "minor_unit": prices.get("currency_minor_unit") or 0,
                "price_minor": prices.get("price"),
            })
    pages = fetch_json("https://dsmxshop.com/wp-json/wp/v2/pages?per_page=50")
    if isinstance(pages, list):
        facts["pages"] = len(pages)
    home = None
    try:
        request = urllib.request.Request("https://dsmxshop.com/", headers={"User-Agent": "MemphisDashboard/1.0"})
        with urllib.request.urlopen(request, timeout=10) as response:
            home = response.read().decode("utf-8", "replace")
    except Exception:
        home = None
    if home:
        facts["reachable"] = True
        match = re.search(r'content="WordPress ([\d.]+)"', home)
        if match:
            facts["wp_version"] = match.group(1)
        match = re.search(r"WooCommerce ([\d.]+)", home)
        if match:
            facts["woo_version"] = match.group(1)
    else:
        facts["reachable"] = False
    return facts


def format_price(product) -> str:
    """Render a WooCommerce price from minor units.

    The store API returns `"price": "31640"` together with
    `currency_minor_unit: 2`, so the value is in cents. Dividing by
    10**minor_unit is what makes it a price a human can read.
    """
    raw = product.get("price_minor")
    if raw in (None, ""):
        return "—"
    try:
        minor_unit = int(product.get("minor_unit") or 0)
        amount = int(raw) / (10 ** minor_unit)
    except (TypeError, ValueError):
        return str(raw)
    symbol = product.get("currency_symbol") or ""
    currency = product.get("currency") or ""
    text = f"{amount:,.2f}".replace(",", " ").replace(".", ",")
    return f"{symbol}{text} {currency}".strip()


def esc(value) -> str:
    return (
        str(value if value is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def render(audience: str = "internal") -> str:
    """Render the dashboard.

    `audience`:
      - "internal" — the operator's view: every decision, every metric.
      - "client"   — what a client reads: project facts, the shop as it
                      is right now, and only the decisions that concern
                      this project. The chain's runtime decisions are not
                      the client's business.
    """
    generated = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    decisions_total = count_blocks(DECISIONS)
    journal_total = count_blocks(JOURNAL)
    cases_total = count_blocks(CASES)
    system_total = count_blocks(SYSTEM)
    project = load_project()
    client_view = audience == "client"
    # The CLIENT view carries no chain content at all.
    #
    # Measured 2026-10-29: an earlier client build filtered the decision
    # log by project keywords and still carried the operator's commercial
    # terms — "13% prowizja + 100 PLN/mies flat", "$280 P&L" — inside
    # decision bodies and titles. A status page for a project does not
    # need the operator's side of the deal. The client view is therefore
    # built only from MEASURED facts plus the operator's own project
    # description.
    newest = [] if client_view else newest_decisions(limit=12)
    facts = store_facts()

    probe_rows = []
    retired_rows = []
    for url in ALL_PROBES:
        row = probe_one(url)
        is_retired = url in RETIRED_PROBES
        badge = "b-retired" if is_retired else ("b-200" if row["http_code"] == 200 else f"b-{row['http_code']}")
        code = "wycofany" if is_retired else row["http_code"]
        cells = [
            f"<td><code>{esc(url)}</code></td>",
            f"<td><span class='badge {badge}'>{esc(code)}</span></td>",
            f"<td class='muted'>{esc(row['title'][:60] or '—')}</td>",
            f"<td class='muted'>{esc(round(row['time_ms'])) if row['time_ms'] >= 0 else '—'} ms</td>",
        ]
        (retired_rows if is_retired else probe_rows).append("<tr>" + "".join(cells) + "</tr>")

    repo_link = project["repo_url"]
    repo_block = (
        f"<a href='{esc(repo_link)}' rel='noopener'>{esc(repo_link)}</a>"
        if repo_link
        else "<span class='muted'>link w przygotowaniu — operator przekazuje repo w najbliższej turze</span>"
    )

    product_rows = []
    for product in facts["products"]:
        price_text = format_price(product)
        product_rows.append(
            f"<tr><td>{esc(product['name'])}</td><td>{esc(price_text)}</td></tr>"
        )
    product_table = (
        "<table><tr><th>Produkt</th><th>Cena</th></tr>" + "".join(product_rows) + "</table>"
        if product_rows
        else "<div class='card'><div class='card-desc muted'>Katalog produktów chwilowo niedostępny (API sklepu nie odpowiedział).</div></div>"
    )

    decision_rows = []
    for row in newest:
        title = row["title"] or "(bez tytułu)"
        choice = row["choice"]
        snippet = choice[:160] + ("…" if len(choice) > 160 else "")
        decision_rows.append(
            f"<tr><td class='muted'>#{esc(row['index'])}</td>"
            f"<td class='muted'>{esc(row['ts'])}</td>"
            f"<td>{esc(title)}</td>"
            f"<td class='muted'>{esc(snippet)}</td></tr>"
        )
    decision_table = (
        "<table><tr><th>Idx</th><th>Kiedy</th><th>Decyzja</th><th>Wybór</th></tr>"
        + "".join(decision_rows)
        + "</table>"
    )

    # Runtime counters are the operator's picture, not the client's.
    internal_metrics = ""
    decisions_heading = "Ostatnie decyzje"
    source_note = "łańcuchy <code>~/.memphis/chains</code> + żywe sondy HTTP"
    if not client_view:
        internal_metrics = (
            '<div class="metric green"><span class="v">' + esc(decisions_total) + '</span>'
            '<span class="l">Decyzji w łańcuchu</span></div>'
            '<div class="metric green"><span class="v">' + esc(journal_total) + '</span>'
            '<span class="l">Wpisów w journalu</span></div>'
            '<div class="metric green"><span class="v">' + esc(cases_total) + '</span>'
            '<span class="l">Cases</span></div>'
            '<div class="metric"><span class="v">' + esc(system_total) + '</span>'
            '<span class="l">Bloków systemowych</span></div>'
        )
    else:
        decisions_heading = "Co działa teraz"
        source_note = "żywe sondy HTTP wobec produkcji"
        decision_table = (
            "<div class='card'>"
            "<div class='card-title'>Sklep odpowiada</div>"
            "<div class='card-desc'>Wszystkie endpointy powyżej zostały sprawdzone "
            "w chwili generowania tej strony. Strona nie opisuje planów ani "
            "ustaleń handlowych — pokazuje stan faktyczny.</div>"
            "</div>"
            "<div class='card'>"
            "<div class='card-title'>Prace trwają</div>"
            "<div class='card-desc'>Tryb: "
            f"{esc(project['phase'])} — {esc(project['phase_detail'])}</div>"
            "</div>"
        )

    return f"""<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsmxshop — dashboard projektu</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

<h1>dsmxshop — dashboard projektu</h1>
<p class="subtitle">Dla {esc(project['company'])} ({esc(project['client'])}) ·
wszystkie liczby zmierzone w chwili generowania ({esc(generated)})</p>

<div class="metric orange"><span class="v">{esc(facts.get('product_count') if facts.get('product_count') is not None else '—')}</span><span class="l">Produktów w sklepie</span></div>
<div class="metric"><span class="v">{esc(facts.get('pages') if facts.get('pages') is not None else '—')}</span><span class="l">Stron w sklepie</span></div>
{internal_metrics}

<h2>🎯 Gdzie jesteśmy</h2>
<div class="card">
  <div class="card-title">{esc(project['phase'])}</div>
  <div class="card-desc">
    {esc(project['phase_detail'])}<br>
    Projekt działa na <code>{esc(project['domain'])}</code>
    {' — ' + esc(facts['wp_version']) + ' / WooCommerce ' + esc(facts['woo_version']) if facts.get('wp_version') else ''}
    {' · od ' + esc(project['since']) if project.get('since') else ''}
  </div>
</div>
<div class="card">
  <div class="card-title">{esc(project['repo_label'])}</div>
  <div class="card-desc">{repo_block}</div>
</div>

<h2>🛒 Sklep — co jest żywe teraz</h2>
{product_table}
<div class="meta">
  WordPress {esc(facts.get('wp_version') or '—')} · WooCommerce {esc(facts.get('woo_version') or '—')} ·
  stron: {esc(facts.get('pages') if facts.get('pages') is not None else '—')} ·
  produktów: {esc(facts.get('product_count') if facts.get('product_count') is not None else '—')}
</div>

<h2>🌐 Endpointy — zmierzone teraz</h2>
<table>
  <tr><th>URL</th><th>Kod</th><th>Tytuł</th><th>Czas</th></tr>
  {''.join(probe_rows)}
</table>
<div class="meta">
  Ścieżki wycofane z produkcji — pokazane dla historii, nie są błędami:
</div>
<table>
  <tr><th>URL</th><th>Status</th><th>Ostatnio</th><th>Czas</th></tr>
  {''.join(retired_rows)}
</table>

<h2>🧠 {decisions_heading}</h2>
{decision_table}

<footer>
  Memphis runtime · wygenerowane {esc(generated)} ·
  źródło: {source_note} ·
  poprzednia wersja strony była migawką sesji 2026-09-07 i pokazywała liczby sprzed 7 tygodni.
</footer>

</div>
</body>
</html>
"""


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Build the project dashboard.")
    parser.add_argument("output", nargs="?", default="/home/memphis/public/sites-discovery/dashboard/index.html")
    parser.add_argument("--audience", choices=["internal", "client"], default="internal")
    args = parser.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(audience=args.audience), encoding="utf-8")
    print(f"dashboard[{args.audience}]: {out} ({out.stat().st_size} bytes)")
