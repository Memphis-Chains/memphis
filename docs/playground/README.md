# docs/playground — standalone pages, not part of the product

These are self-contained HTML pages generated during a session. Each opens on
its own, in any browser, with no build step and no dependency on the runtime.

They are **not** part of `sites/` and are never deployed. The web estate under
`sites/` is the only thing `sites-sync.sh` publishes, and it publishes by
explicit path, so nothing here can reach production by accident.

| File | What it is |
| ---- | ---------- |
| `MEMPHIS-HYMN.html`          | Text and layout for a marching hymn about the runtime. Independent cinema framing, no product claim beyond what the code does. |
| `MEMPHIS-HIT.html`           | One-paragraph version of the same, the shortest thing worth copying. |
| `WATRA-HYMN.html`            | Same treatment for the Watra concept, with an explicit gap list (Agora, Matrix) instead of pretending those ship. |
| `TETRADODECAICOSAHEDRON.html` | Convex hull of a dodecahedron + icosahedron on one sphere. Numbers in the page are measured, not asserted. |
| `TETRADODECAICOSAHEDRON-VARIANTS.html` | Three hybrid variants of that hull, each with its own V/E/F. The SVG references PNG fallbacks rendered without a browser. |

## Honesty rules these follow

- Any number printed on the page was measured by a run, not typed by hand.
- Where a name in the request does not exist in the domain (a polyhedron that
  is not in the literature, a market that is not implemented), the page says so
  instead of adopting the name.
- Where the platform's own metrics had drifted, the generator was re-run before
  publishing rather than shipping a corrected sentence with a stale number.

## Rendering note

Firefox on this host is a snap and cannot open a window from an `xdg-open`
invocation, so the polyhedron pages ship as rasterised PNG referenced by the
HTML. Regenerate with the scripts under `tmp/` (scratch, not committed) if the
geometry changes.