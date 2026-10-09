#!/usr/bin/env python3
"""leakscan.py — find files that are publicly readable but were never meant to be.

Two signals, not one. Conflating them is what makes a scanner useless: a rule
like "*.html is suspicious" reports 42 false positives on a real site, because
every page is an .html file.

BLOCK — high confidence, act now
    A publicly readable file that is a working artifact by any reasonable
    definition: a backup, an editor swap file, a snapshot directory, a log, a
    database, a key, an env file. Nobody intended to publish these. A 403 on the
    parent directory does not help: Apache hides the listing, then happily serves
    every file inside.

WARN — needs a human decision
    A publicly readable file the crawl never reached. Often fine: assets pulled in
    by CSS background-image, pages deliberately unlinked, another project's
    directory sharing the account. Sometimes a real leak of content. The scanner
    cannot tell those apart, so it must not claim to.

The reachability crawl
----------------------
BFS from the home page over same-origin href/src, bounded in depth and page
count, seeded from sitemap.xml, following CSS url() references because a
background image is genuinely published even though no anchor points at it.
Everything it reaches is published by definition.

Probing both URL shapes
-----------------------
A docroot path is reachable under more than one URL, and only checking one shape
hides real leaks:

    foo/index.html   ->  /foo/          and  /foo/index.html
    .env.bak         ->  /.env.bak      and  /env.bak
    .index.html.swp  ->  /.index.html.swp and /index.html.swp

`normalize()` strips the leading dot because that is how a directory index maps
to a URL path. Applied to a dotfile it produces a path that also answers 200, so
every dotfile must be probed under both names. Checking only the normalized form
is how a scan reports "clean" while three secrets sit in the docroot.

Usage
-----
    leakscan.py --domain https://example.pl --listing docroot.tsv [--json]
    listing lines: "<size>\\t<path relative to docroot>"
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
import urllib.error
import urllib.request
from collections import deque

DEPTH = 3
MAX_PAGES = 120
TIMEOUT = 20
UA = "memphis-sites-leakscan/1.0"

# ── BLOCK: artifacts nobody means to publish ────────────────────────────────
BLOCK_EXTS = (
    "*.bak", "*.backup", "*.old", "*.orig", "*.save", "*~", "*.swp", "*.swo",
    "*.tmp", "*.temp", "*.log", "*.sql", "*.sqlite", "*.sqlite3", "*.db",
    "*.env", "*.key", "*.pem", "*.pfx", "*.p12", "*.crt", "*.asc", "*.gpg",
    ".DS_Store", "*.pyc", "*.map", "*.htpasswd", "*.pid", "*.lock",
)
BLOCK_NAMES = (
    "*.before-*", "*.pre-*", "*.post-*", "index.before-*",
    "*.backup-*", "*-backup-*", "*.snapshot",
)
BLOCK_DIRS = (
    ".memphis-snapshots/", ".snapshot/", ".snapshots/", ".backup/", ".bak/",
    ".trash/", ".cache/", "node_modules/", ".git/", "vendor/",
)
SKIP_PREFIXES = (
    "/.well-known/", "/panel/", "/panel-app/", "/api/", "/data/",
    "/cgi-bin/", "/vendor/", "/node_modules/",
)

ROOT_FILES = {
    "/robots.txt", "/sitemap.xml", "/llms.txt", "/agents.json", "/404.html",
    "/favicon.ico", "/favicon.svg", "/apple-touch-icon.png",
    "/manifest.webmanifest", "/browserconfig.xml", "/humans.txt", "/security.txt",
}

ASSET_RE = re.compile(r"""url\(\s*['"]?(?!data:|https?:|//)([^'")]+)['"]?\s*\)""", re.I)
CSS_IMPORT_RE = re.compile(r"""@import\s+['"]([^'"]+)['"]""", re.I)


def url_shapes(rel: str) -> list[str]:
    """Every URL path a docroot file is served at.

    `index.html` inside a directory is served at the directory, and also at its
    literal path. Dotfiles keep their dot in the real URL and additionally answer
    without it, so both must be probed or a leak is reported as clean.
    """
    raw = "/" + rel.lstrip("/")
    shapes: list[str] = []

    if raw.endswith("/index.html"):
        shapes.append(raw[: -len("index.html")])
    elif raw.endswith("/index.htm"):
        shapes.append(raw[: -len("index.htm")])
    shapes.append(raw)

    # the dot-stripped twin of a dotfile
    parts = raw.split("/")
    if len(parts) > 1 and parts[-1].startswith("."):
        twin = "/".join(parts[:-1] + [parts[-1].lstrip(".")])
        if twin != raw:
            shapes.append(twin)

    out: list[str] = []
    for s in shapes:
        if s not in out:
            out.append(s)
    return out


def fetch(url: str) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, b"", ""
    except Exception:
        return 0, b"", ""


def refs_of(body: bytes, content_type: str) -> set[str]:
    try:
        text = body.decode("utf-8", "replace")
    except Exception:
        return set()
    out: set[str] = set()

    if "css" in content_type:
        for m in ASSET_RE.finditer(text):
            u = m.group(1).strip()
            if u.startswith("/"):
                out.add(u.split("?")[0].split("#")[0])
        for m in CSS_IMPORT_RE.finditer(text):
            u = m.group(1).strip()
            if u.startswith("/"):
                out.add(u.split("?")[0].split("#")[0])
        return out

    for m in re.finditer(r'(?:href|src)\s*=\s*"([^"]+)"', text):
        u = m.group(1).strip()
        if not u or u.startswith(("http://", "https://", "//", "mailto:", "tel:", "data:", "javascript:", "#")):
            continue
        p = u.split("#")[0].split("?")[0]
        if p.startswith("/"):
            out.add(p)
    return out


def crawl(domain: str) -> tuple[set[str], int, list[str]]:
    seen: set[str] = set()
    errors: list[str] = []
    queue: deque[tuple[str, int]] = deque([("/", 0)])
    pages = 0

    st, body, _ = fetch(domain + "/sitemap.xml")
    if st == 200:
        for m in re.finditer(r"<loc>\s*([^<]+?)\s*</loc>", body.decode("utf-8", "replace")):
            u = m.group(1)
            if u.startswith(domain):
                p = u[len(domain):] or "/"
                if p not in seen:
                    queue.append((p, 0))

    while queue and pages < MAX_PAGES:
        path, depth = queue.popleft()
        if path in seen:
            continue
        status, data, ct = fetch(domain + path)
        seen.add(path)
        if status == 0:
            errors.append(path)
            continue
        if not (200 <= status < 300) or not data:
            continue
        pages += 1
        if depth >= DEPTH:
            continue
        for ref in refs_of(data, ct):
            if ref not in seen:
                queue.append((ref, depth + 1))

    return seen, pages, errors


def classify_block(rel: str) -> str | None:
    path = "/" + rel
    name = rel.rsplit("/", 1)[-1]
    for seg in BLOCK_DIRS:
        if seg in path + "/":
            return f"inside a working directory ({seg.strip('/')})"
    for pat in BLOCK_EXTS + BLOCK_NAMES:
        if fnmatch.fnmatch(name, pat):
            return f"artifact filename matches {pat}"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--listing", required=True)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--warn-unpublished", action="store_true")
    args = ap.parse_args()

    domain = args.domain.rstrip("/")

    files: list[tuple[int, str]] = []
    with open(args.listing, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            size_s, _, rel = line.partition("\t")
            if rel:
                files.append((int(size_s or 0), rel))

    reached, pages, errors = crawl(domain)
    allow = reached | ROOT_FILES

    blocks: list[dict] = []
    warns: list[dict] = []

    for size, rel in files:
        reason = classify_block(rel)
        if reason is None and not args.warn_unpublished:
            continue
        if reason is None:
            # only look at files the crawl could not account for
            if any(s in allow for s in url_shapes(rel)):
                continue

        for shape in url_shapes(rel):
            if shape.startswith(SKIP_PREFIXES) or shape == "/.htaccess":
                continue
            status, _, _ = fetch(domain + shape)
            if status != 200:
                continue
            entry = {
                "level": "block" if reason else "warn",
                "site": domain,
                "path": shape,
                "detail": f"{domain}{shape} ({size} B) — "
                          + (f"publicly readable, {reason}" if reason
                             else "readable but not reached by the crawl; confirm it is meant to be public"),
            }
            if reason and not any(b["path"] == shape for b in blocks):
                blocks.append(entry)
            elif not reason and not any(w["path"] == shape for w in warns):
                warns.append(entry)
            break  # one finding per file is enough

    summary = {
        "domain": domain,
        "docroot_files": len(files),
        "crawl_reached_paths": len(reached),
        "crawl_pages_fetched": pages,
        "crawl_unreachable": len(errors),
        "blocks": len(blocks),
        "warns": len(warns),
    }

    if args.json:
        print(json.dumps({"summary": summary, "findings": blocks + warns},
                         ensure_ascii=False, indent=2))
    else:
        print(f"── {domain}")
        print(
            f"  docroot {len(files)} file(s) | crawl reached {len(reached)} path(s) "
            f"in {pages} fetch(es) | BLOCK {len(blocks)} | warn {len(warns)}"
        )
        for f in blocks:
            print(f"  \033[31mBLOCK\033[0m  {f['detail']}")
        for f in warns[:25]:
            print(f"  \033[33mwarn\033[0m  {f['detail']}")

    return 1 if blocks else 0


if __name__ == "__main__":
    sys.exit(main())