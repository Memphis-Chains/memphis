#!/usr/bin/env python3
"""Memphis Dashboard API — read-only SQLite queries for /dashboard/db.html.
Tier-0 only. No LLM. No new dependencies. Stdlib only."""
import http.server, sqlite3, json, urllib.request, urllib.parse
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import os, time

PORT = int(os.environ.get("DASH_API_PORT", "8766"))
DB = "/home/memphis/memphis/data/dashboard.db"
LOG = "/tmp/dashboard-api.log"

# known endpoints to probe (idempotent, in-process; not persistent cron)
PROBES = [
  "http://dsmxshop.com/szczepan/",
  "http://dsmxshop.com/usa/",
  "http://dsmxshop.com/extra/",
  "http://dsmxshop.com/bonus/",
  "http://localhost:8765/szczepan/",
]

def query_stats():
  con = sqlite3.connect(DB); c = con.cursor()
  n = c.execute("SELECT COUNT(*), MIN(idx), MAX(idx) FROM decisions_log").fetchone()
  gaps = (n[2]-n[1]+1) - n[0] if (n[1] is not None and n[2] is not None) else 0
  probes = c.execute("SELECT COUNT(*) FROM http_probes").fetchone()[0]
  st = Path(DB).stat()
  age_min = int((time.time() - st.st_mtime)/60)
  size = st.st_size
  if size > 1048576: size_h = f"{size/1048576:.2f} MB"
  elif size > 1024: size_h = f"{size/1024:.1f} KB"
  else: size_h = f"{size} B"
  con.close()
  return {"decisions": n[0], "probes": probes, "gaps": max(0,gaps), "uptime_min": age_min, "db_size_human": size_h}

def query_probes(limit=20):
  con = sqlite3.connect(DB); c = con.cursor()
  rows = c.execute("""SELECT url, http_code, bytes, time_ms, title FROM http_probes
    WHERE id IN (SELECT MAX(id) FROM http_probes GROUP BY url)
    ORDER BY url""").fetchall()
  con.close()
  return [{"url":u, "http_code":h, "bytes":b, "time_ms":t, "title":ti} for u,h,b,t,ti in rows]

def query_decisions(limit=10):
  con = sqlite3.connect(DB); c = con.cursor()
  rows = c.execute("SELECT idx, ts, title FROM decisions_log ORDER BY idx DESC LIMIT ?", (limit,)).fetchall()
  con.close()
  return [{"idx":i, "ts":t, "title":ti} for i,t,ti in rows]

def do_probes():
  con = sqlite3.connect(DB); c = con.cursor()
  for u in PROBES:
    try:
      t0 = time.time()
      req = urllib.request.Request(u, headers={"User-Agent":"MemphisDashboardAPI/1.0"})
      with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read()
        dt = (time.time()-t0)*1000
        title = ""
        if b"<title>" in body[:2000]:
          ts = body.find(b"<title>")+7
          te = body.find(b"</title>", ts)
          title = body[ts:te].decode("utf-8","replace")[:80]
        c.execute("INSERT INTO http_probes(url,ts,http_code,bytes,time_ms,title) VALUES (?,?,?,?,?,?)",
          (u, time.strftime("%Y-%m-%dT%H:%M:%S"), r.status, len(body), round(dt,1), title))
    except Exception as e:
      c.execute("INSERT INTO http_probes(url,ts,http_code,bytes,time_ms,title) VALUES (?,?,?,?,?,?)",
        (u, time.strftime("%Y-%m-%dT%H:%M:%S"), 0, 0, -1, str(e)[:80]))
  con.commit(); con.close()

class H(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a, **k): pass  # silent
  def do_GET(self):
    u = urlparse(self.path)
    q = parse_qs(u.query)
    limit = int(q.get("limit",["10"])[0])
    if u.path == "/dashboard/db-api":
      try:
        data = {"stats": query_stats(), "probes": query_probes(), "decisions": query_decisions(limit)}
        body = json.dumps(data).encode()
        self.send_response(200); self.send_header("Content-Type","application/json")
        self.send_header("Cache-Control","no-store"); self.send_header("Content-Length",str(len(body))); self.end_headers()
        self.wfile.write(body)
        Path(LOG).write_text(f"{time.strftime('%H:%M:%S')} 200 ok\n")
      except Exception as e:
        body = json.dumps({"error":str(e)}).encode()
        self.send_response(500); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(body)
    elif u.path == "/dashboard/probe-now":
      do_probes()
      self.send_response(200); self.send_header("Content-Type","text/plain"); self.end_headers()
      self.wfile.write(b"probes done")
    elif u.path == "/health":
      self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    else:
      self.send_response(404); self.end_headers()

if __name__=="__main__":
  Path(LOG).parent.mkdir(parents=True, exist_ok=True)
  # initial probe so DB has data
  do_probes()
  s = http.server.HTTPServer(("127.0.0.1", PORT), H)
  s.serve_forever()
