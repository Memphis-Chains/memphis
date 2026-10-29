#!/usr/bin/env python3
"""Single source of truth for the dashboard's HTTP probe list.

WHY THIS FILE EXISTS
--------------------
The probe list was duplicated in `seed-dashboard-db.py` and
`dashboard-api.py`. Two copies drift silently — and they HAD drifted:
measured 2026-10-29, the four dsmxshop paths the dashboard probed
(`/szczepan/`, `/usa/`, `/extra/`, `/bonus/`) all returned **404** on
production, so the dashboard reported "err" for pages that simply do
not exist any more. A probe that measures a deleted path is not a
measurement — it is a permanent false alarm.

The list below was measured on 2026-10-29 against production:

    https://dsmxshop.com/            200   (WordPress 7.1.4, WooCommerce 11.2.1)
    https://dsmxshop.com/en/         200   (English landing)
    https://dsmxshop.com/shop/       200   (WooCommerce shop)
    https://dsmxshop.com/robots.txt  200
    https://dsmxshop.com/wp-json/wp/v2/pages?per_page=1  200  (6 pages)
    https://dsmxshop.com/szczepan/   404   <- retired, was live 2026-09-08
    https://dsmxshop.com/usa/        404   <- retired, was live 2026-09-17
    https://dsmxshop.com/extra/      404   <- retired, was live 2026-09-17
    https://dsmxshop.com/bonus/      404   <- retired, was live 2026-09-17

`RETIRED_PROBES` keeps the old paths visible in the dashboard as
"retired" instead of as errors, so the history stays readable and
nobody re-adds them by accident.

Stdlib only — the dashboard must keep running with no dependencies.
"""
import time
import urllib.request

# Live endpoints, measured 2026-10-29.
PROBES = [
    "https://dsmxshop.com/",
    "https://dsmxshop.com/en/",
    "https://dsmxshop.com/shop/",
    "https://dsmxshop.com/robots.txt",
    "https://dsmxshop.com/wp-json/wp/v2/pages?per_page=1",
    "http://localhost:8765/szczepan/",
]

# Endpoints that used to exist and were removed from production. Kept
# for history; they are probed as well and reported as `retired`.
RETIRED_PROBES = [
    "https://dsmxshop.com/szczepan/",
    "https://dsmxshop.com/usa/",
    "https://dsmxshop.com/extra/",
    "https://dsmxshop.com/bonus/",
]

ALL_PROBES = PROBES + RETIRED_PROBES

USER_AGENT = "MemphisDashboard/1.0"
TIMEOUT_SECONDS = 8


def probe_one(url):
    """Probe a single URL. Never raises — a failed probe is a row."""
    try:
        started = time.time()
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
            elapsed_ms = round((time.time() - started) * 1000, 1)
            title = ""
            if b"<title>" in body[:2000]:
                start = body.find(b"<title>") + 7
                end = body.find(b"</title>", start)
                if end > start:
                    title = body[start:end].decode("utf-8", "replace")[:80]
            return {
                "url": url,
                "http_code": response.status,
                "bytes": len(body),
                "time_ms": elapsed_ms,
                "title": title,
            }
    except urllib.error.HTTPError as error:
        # A real HTTP status (404 etc.) is a measurement, not a crash.
        return {
            "url": url,
            "http_code": error.code,
            "bytes": 0,
            "time_ms": -1.0,
            "title": f"HTTP {error.code}",
        }
    except Exception as error:
        return {
            "url": url,
            "http_code": 0,
            "bytes": 0,
            "time_ms": -1.0,
            "title": str(error)[:80],
        }


def probe_all(urls=None):
    """Probe every URL and return the rows in dashboard order."""
    return [probe_one(url) for url in (urls if urls is not None else ALL_PROBES)]
