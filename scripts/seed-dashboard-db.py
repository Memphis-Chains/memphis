#!/usr/bin/env python3
"""Reseed dashboard.db from decisions chain + run fresh probes.
Idempotent. Run manually or via cron daily."""
import sqlite3, json, time, urllib.request
from pathlib import Path

DB = "/home/memphis/memphis/data/dashboard.db"
CHAIN = Path("/home/memphis/.memphis/chains/decisions")
PROBES = [
  "http://dsmxshop.com/szczepan/",
  "http://dsmxshop.com/usa/",
  "http://dsmxshop.com/extra/",
  "http://dsmxshop.com/bonus/",
  "http://localhost:8765/szczepan/",
]

con = sqlite3.connect(DB); c = con.cursor()

# Drop & recreate (clean migration)
for t in ("decisions_log","http_probes","system_events"):
  c.execute(f"DROP TABLE IF EXISTS {t}")

c.execute("""CREATE TABLE decisions_log (
  idx INTEGER PRIMARY KEY, ts TEXT NOT NULL, title TEXT NOT NULL, context TEXT)""")
c.execute("""CREATE TABLE http_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, ts TEXT NOT NULL,
  http_code INTEGER, bytes INTEGER, time_ms REAL, title TEXT)""")
c.execute("""CREATE TABLE system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  level TEXT NOT NULL, source TEXT, event TEXT)""")

n = 0
for fp in sorted(CHAIN.glob("*.json")):
  try:
    j = json.loads(fp.read_text()); d = j.get("data", {})
    title = (d.get("title","")[:200] + " | " + (d.get("choice") or "")[:300])[:500]
    c.execute("INSERT OR IGNORE INTO decisions_log VALUES (?,?,?,?)",
      (j["index"], j.get("timestamp",""), title, (d.get("context") or "")[:500]))
    n += 1
  except Exception: pass

for u in PROBES:
  try:
    t0 = time.time()
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"MemphisDashboard/1.0"}), timeout=8) as r:
      body = r.read(); dt = (time.time()-t0)*1000
      title = ""
      if b"<title>" in body[:2000]:
        ts = body.find(b"<title>")+7; te = body.find(b"</title>", ts)
        title = body[ts:te].decode("utf-8","replace")[:80]
      c.execute("INSERT INTO http_probes(url,ts,http_code,bytes,time_ms,title) VALUES (?,?,?,?,?,?)",
        (u, time.strftime("%Y-%m-%dT%H:%M:%S"), r.status, len(body), round(dt,1), title))
  except Exception as e:
    c.execute("INSERT INTO http_probes(url,ts,http_code,bytes,time_ms,title) VALUES (?,?,?,?,?,?)",
      (u, time.strftime("%Y-%m-%dT%H:%M:%S"), 0, 0, -1, str(e)[:80]))

c.execute("INSERT INTO system_events(ts,level,source,event) VALUES (?,?,?,?)",
  (time.strftime("%Y-%m-%dT%H:%M:%S"),"info","seed",f"reseed ok: {n} decisions"))
con.commit(); con.close()
print(f"seed: {n} decisions, {len(PROBES)} probes")
