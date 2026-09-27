---
name: remote-site-edit
description: Deploy, audit, and maintain a static site served from a remote webroot over SSH (e.g. memphis-v5.pl on lh.pl). Covers the full flow: find deploy target, snapshot, write, verify, rollback — plus pre-deploy audit (public leaks, missing standards files, design drift, stale facts), .htaccess maintenance, binary assets, and post-deploy verification. Hard rules: never delete without a backup outside the docroot.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Remote site edit — SSH webroot operations

When operator says "edytuj stronę", "deploy na X", "update the site", "rozwiń stronę", "zrób stronę zgodnie z dzisiejszymi standardami", or any variation of "make a change visible on a hosted site" — this is what they mean.

This is **not** a git push. It is SSH/SCP to the webroot of a shared-hosting account.

## Trigger conditions

- Operator says "edytuj remote" / "edytuj stronę" / "deploy na X" / "publish to Y" / "rozwiń stronę"
- Operator references a domain (`memphis-v5.pl`, `marcin-kukla.pl`, `dsmxshop.com`)
- Operator asks to make a file change visible to public visitors
- Operator asks to audit a live site ("co tam mamy na serwerze", "czego brakuje do pełnej funkcjonującej strony")

## Infrastructure: how lh.pl is reached

The site is NOT served from a local path. It lives on a shared-hosting box reached over SSH.

```bash
SSH_CONFIG=~/.ssh/lhpl-active/config          # NOT ~/.ssh/config
HOST=lhpl                                     # resolves to serwer437043.lh.pl:40022

# read-only recon
ssh -F $SSH_CONFIG -o ConnectTimeout=25 $HOST 'ls -la public_html/'

# write: back up first, then push one file at a time
scp -F $SSH_CONFIG -q local.html $HOST:public_html/<site>/index.html
```

`~/.ssh/lhpl-active/config` defines host `lhpl` with `HostName serwer437043.lh.pl`, `Port 40022`, and an ed25519 identity. There is no key in the default `~/.ssh/config`.

**SSH is flaky on this host.** Expect `Timeout, server not responding` roughly every 3rd–4th call. That is not a failure of the change — just retry with `-o ConnectTimeout=30`. Do not conclude "no access" from a single timeout.

**Docroot vs parent.** `public_html/` is the parent. `public_html/<site>/` is the DocumentRoot for that vhost. A file placed in `public_html/privacy/index.html` is NOT served at `/privacy/` — it must be `public_html/<site>/privacy/index.html`. Getting this wrong once cost a whole debugging detour; `ls` both levels before writing anything.

**Home is writable and outside the webroot:** `~` = `/home/platne/serwer437043`. This is where backups belong.

```bash
ssh -F $SSH_CONFIG $HOST 'mkdir -p ~/site-backups/<site> && echo ok'
```

## Deploy target pattern

```
~/site-backups/<site>/                 ← backups, OUTSIDE docroot (public_html)
public_html/
├── <site>/                           ← DocumentRoot for that domain
│   ├── index.html
│   ├── .htaccess
│   ├── robots.txt  sitemap.xml  llms.txt  agents.json
│   ├── 404.html  manifest.webmanifest  favicon.*  .well-known/
│   └── <subpage>/index.html
├── <unrelated-site-a>/                ← NOT part of this project
└── <unrelated-site-b>/
```

`public_html/` contains **other people's sites** (client projects, personal pages). Only touch `public_html/<site>/`. A directory listing will show you what exists; do not "fix" what you did not come for.

## Workflow (6 steps)

```
0. AUDIT (skip if operator named an exact file and change)
   See "Pre-deploy audit" below. Cheap: curl HEAD on every internal link.

1. FIND the target
   ssh -F $SSH_CONFIG $HOST 'ls -la public_html/<site>/'

2. SNAPSHOT outside the docroot
   TS=$(date +%Y%m%d-%H%M)
   ssh -F $SSH_CONFIG $HOST "cp public_html/<site>/<file> ~/site-backups/<site>/<file>.$TS.bak"

3. COPY — one file at a time
   scp -F $SSH_CONFIG -q local.html $HOST:public_html/<site>/<file>

4. VERIFY over HTTP, not just on disk
   curl -s -o /dev/null -w '%{http_code} %{size_download}' https://<domain>/<file>
   grep -c '<expected-token>' <local copy>

5. REPORT source, target, backup, sizes, verified tokens
```

## Pre-deploy audit

Run this when the operator asks what is on the server, what is missing, or to bring the site up to standard. Each item below was a real finding, not a hypothetical.

### Public leaks — check every time

Any file matching these is served to the public:

```bash
ssh -F $SSH_CONFIG $HOST 'ls public_html/<site>/' | grep -E 'backup|\.bak|\.md$|~$|\.orig'
```

```
index.html.backup-2026-09-26-pre-v2-deploy   200, 29 KB
REFACTOR_SPEC.md                              200,  4 KB   ← internal dev note
```

Five old page versions plus an internal spec were publicly readable. **Move, never delete:**

```bash
ssh -F $SSH_CONFIG $HOST 'mkdir -p ~/site-backups/<site> && cd public_html/<site> && mv index.html.backup-* ~/site-backups/<site>/'
```

### Missing standards files

Check each; all are expected on a real site:

| Path | Consequence if 404 |
|---|---|
| `favicon.svg`, `favicon.ico` | broken tab icon; subpages may link a file that does not exist |
| `og:image` (e.g. `memphis-os-social-preview.jpg`) | social previews dead on FB/LinkedIn/X |
| `404.html` | default server error page — and if `.htaccess` lacks `ErrorDocument`, it is never served even when it exists |
| `manifest.webmanifest` | no PWA |
| `.well-known/security.txt` | no channel to report vulnerabilities |

`404.html` is the sneaky one: the file existing is not enough. Apache serves it only via `ErrorDocument`. Verify with `curl -o /dev/null -w '%{http_code}' https://<domain>/definitely-not-a-real-page` and confirm the body is your page.

### Design drift between pages

Compare the colour tokens each page declares:

```bash
for p in "" start/ docs/ roadmap/ demo/; do
  echo "--- /$p"
  curl -s https://<domain>/$p | grep -oE '#[0-9a-fA-F]{6}' | sort | uniq -c | sort -rn | head -5
done
```

Four product pages were dark navy `#040509` with a teal accent while the home page was cream `#f4f1ea` with no teal anywhere. Four pages, four palettes, one brand.

To recolour a token-driven page safely: remap the `:root` custom properties, then swap the literals, then flip `rgba(255,255,255,α)` overlays to `rgba(0,0,0,α)`. Verify with a grep for the old dark values — target is zero. Then check contrast, do not eyeball it:

```python
def lum(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c*2 for c in h)
    f = lambda c: c/12.92 if c <= 0.03928 else ((c+0.055)/1.055)**2.4
    r,g,b = map(f, [int(h[i:i+2],16)/255 for i in (0,2,4)])
    return 0.2126*r + 0.7152*g + 0.0722*b
cr = (max(lum(a),lum(b))+.05) / (min(lum(a),lum(b))+.05)
```

WCAG AA needs 4.5:1 for body text, 3:1 for large text and UI borders.

### Stale facts

Dates and version strings outlive the deploy that set them. A page said "Stan na 22 kwietnia 2026" and "current release v1.11.0" months after the runtime moved on.

```bash
curl -s https://<domain>/<page> | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+|20[0-9]{2}-[0-9]{2}-[0-9]{2}' | sort -u
```

Cross-check against the real source of truth — `git describe --tags`, `package.json`, the changelog. Not memory.

A version string inside a **timeline or changelog** is history and stays. Only change it where the page claims to describe the *current* state. Read the sentence around it before editing.

## Binary assets

Generate locally, upload, keep the generator in the repo.

**Images** — Python + Pillow is available. For a favicon, draw flat geometry rather than downscaling a photo (a 256×256 photo is unreadable at 16×16):

```python
im = Image.new('RGBA', (256,256), (0,0,0,0))
d = ImageDraw.Draw(im)
d.rounded_rectangle([0,0,255,255], radius=48, fill=(244,241,234,255))
im.save('favicon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
```

Note: `im.save(..., sizes=[...], append_images=None)` raises `TypeError` — omit the kwarg.

**Video** — ffmpeg with `drawtext`, DejaVuSansMono at `/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`. Keep every command on screen identical to the README, verified by fetching the README over HTTP rather than quoting from memory.

Compare codecs before shipping both. A webm VP9 of flat-colour terminal cards came out **larger** than the h264 mp4 (439 KB vs 350 KB) — VP9 is poor at large uniform areas. Ship mp4 unless testing shows otherwise.

Add `preload="none"` and a poster frame. A page should not pull 350 KB of video before anyone presses play.

Verify a rendered video without a browser by sampling frames and checking the pixel distribution — dominant background ~95% plus expected accents means text drew correctly:

```bash
ffmpeg -y -ss 8 -i out.mp4 -frames:v 1 f8.png
python3 -c "
from PIL import Image; import collections
c = collections.Counter(Image.open('f8.png').convert('RGB').getdata())
print(c.most_common(4))"
```

## .htaccess maintenance

The original was 615 bytes: HTTPS redirect and HSTS, nothing else. A static site in 2026 wants:

```apache
ErrorDocument 404 /404.html

<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/plain text/css text/xml
    AddOutputFilterByType DEFLATE application/javascript application/json
    AddOutputFilterByType DEFLATE image/svg+xml
</IfModule>

<IfModule mod_headers.c>
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    Header always set Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()"
    <FilesMatch "\.(html|json|txt|xml|webmanifest)$">
        Header set Cache-Control "public, max-age=0, must-revalidate"
    </FilesMatch>
    <FilesMatch "\.(svg|ico|jpg|png|webp|woff2?)$">
        Header set Cache-Control "public, max-age=2592000, immutable"
    </FilesMatch>
</IfModule>

<IfModule mod_mime.c>
    AddType image/svg+xml .svg
    AddType image/x-icon .ico
    AddType application/manifest+json .webmanifest
</IfModule>

Options -Indexes
```

Backup first — a syntax error here takes the whole site down:

```bash
ssh -F $SSH_CONFIG $HOST "cp public_html/<site>/.htaccess ~/site-backups/<site>/.htaccess.$(date +%Y%m%d-%H%M).bak"
```

Then confirm each piece actually took effect over HTTP:

```bash
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' https://<domain>/ | grep -iE 'content-encoding|content-length|cache-control|x-frame'
curl -s -o /dev/null -w '%{http_code}' https://<domain>/no-such-page
```

`content-encoding: gzip` with a content-length well below the raw size proves deflate is live. Do not assume it from the config alone.

## Anti-confab (hard rules — never break)

| Rule | Reason |
|---|---|
| **NEVER write into the docroot without a backup in `~/site-backups/` first** | Production. No git on the server. Backup is the only way back. |
| **NEVER leave backup files inside the docroot** | They are public. Five 30 KB page histories were readable by anyone. Move them out. |
| **NEVER delete backups after success** | Rollback may be needed weeks later. Cost is kilobytes. |
| **NEVER touch `public_html/<other-site>/`** | Other projects and personal pages share this account. Out of scope. |
| **NEVER edit multiple files before verifying the first** | Otherwise you cannot tell which change broke it. |
| **NEVER assume the directory you wrote to is what is served** | `ls` both `public_html/` and `public_html/<site>/`. |
| **NEVER modify `nginx.conf`, vhost files, or reload the server** | Operator's infrastructure. Out of scope. |
| **NEVER claim a link is broken on one failed request** | Re-test. A checker of mine reported `/panel/admin/login` as 404; 20 sequential requests all returned 200. The bug was in my loop. |

## Verification checklist

```bash
# every page and asset
for p in "" start/ docs/ 404.html favicon.ico manifest.webmanifest llms.txt agents.json; do
  printf "  %-28s %s\n" "/$p" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}B' https://<domain>/$p)"
done

# every internal link on the page you just changed
grep -oE '(href|src)="[^"]*"' local.html | sed 's/.*="//;s/"//' \
  | grep -v '^https\?://\|^#\|^data:\|^mailto:' | sort -u \
  | while read l; do printf "  %s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' https://<domain>/$l)" "$l"; done

# leaks gone
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/index.html.backup-whatever   # want 404

# HTML not mangled
python3 -c "
import re,sys
s=open('local.html',encoding='utf-8').read()
for t in ['html','head','body','div','section','script','style']:
    o,c=len(re.findall(rf'<{t}[\s>]',s)),len(re.findall(rf'</{t}>',s))
    print(f'  {t}: {o}/{c}', 'OK' if o==c else 'MISMATCH')"
```

## Rollback

```bash
ssh -F $SSH_CONFIG $HOST "cp ~/site-backups/<site>/<file>.<TS>.bak public_html/<site>/<file>"
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/<file>
```

## Local source of truth

Keep the whole site in the repo so it is reviewable and reproducible. `docs/site/` mirrors the docroot: pages in subdirs, plus `.htaccess`, `404.html`, the meta files, assets, and any generator script. Deploy from there, not from a scratch directory.

Commit and push the repo after the site is verified live. Site work is invisible in git history otherwise.

## Related skills

- `halt-aware-destructive-ops` — run before any `rm` or `mv` against production paths
- `memphis-v5-landing-rebuild` — design tokens and section order for memphis-v5.pl pages
- `memphis-hotfix` — code fixes that cross layers

## Notes

- **Created 2026-09-26** after operator pointed out the gap
- **Revised 2026-09-27** after a full site audit. The original version described only
  "copy a file and check md5". It had no pre-deploy audit, assumed a local deploy
  directory that does not exist, forbade touching `.htaccess` when that is often
  the fix, and had no guidance for binary assets or verification over HTTP.
- **Tier:** 0 — no vault, no passphrase
- **Idempotent:** re-running rotates the backup
- **Reversible:** while a backup exists in `~/site-backups/`
- **Safe by default:** touches only the files the operator named
