# ADR-007 — Harden `src/gateway/url-extract.ts` SSRF Guard

Date: 2026-09-18
Status: Proposed
Deciders: operator (Marcin Kukla), mcode exec session `mvs_df0ab992…`
Supersedes: —
Related: issue #629 (now stale — PR #627 merged the mcp-tools fix
2026-09-16), issue #128, `docs/adr/ADR-006-atomic-embed-index-write.md`

## Context

Two independent SSRF guards exist for outbound HTTP fetches in the Memphis
codebase:

1. `src/mcp/tools/web-fetch.ts::runMemphisWebFetch` — the strong guard. DNS
   pre-resolution, per-hop re-validation, full IPv4 + IPv6 private-range
   block list (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
   `100.64/10` CGNAT, `0/8`, `224/4+`, IPv6 `::1`, `fc00::/7`, `fe80::/10`,
   `::ffff:` mapped re-check, multicast). Merged via PR #627 (commit
   `3b3ebed`, 2026-09-16) — `tests/unit/mcp-web-fetch.test.ts` is 21 passed.
2. `src/gateway/url-extract.ts::isSafeUrl` — the weak guard. Only checks
   protocol, query-string length, and a narrow hostname prefix match
   (`localhost`, `127.0.0.1`, `0.0.0.0`, `192.168.`, `10.`, `172.`).

   This is a different code path. `fetchUrlsFromMessage` is invoked from
   `src/gateway/turn-runtime.ts:843` — every gateway turn that contains a
   URL gets auto-fetched through this guard. The risk surface is wider
   than the MCP `memphis_web_fetch` tool: a poisoned URL pasted into any
   user / Telegram / web-search payload can be exfiltrated through the
   gateway pre-tool-execution stage.

   Concrete gaps versus the strong guard:

   - **169.254/16 not blocked.** Cloud-provider instance metadata
     (AWS `169.254.169.254`, GCP `metadata.google.internal`, Azure
     `169.254.169.254`). This is the single highest-impact SSRF gap.
   - **::1, /f[c-d][0-9a-f]{2}:, /fe[8-b][0-9a-f]: not blocked.** IPv6
     loopback + unique local + link-local.
   - **172.16/12 matched as prefix.** `172.32.0.0/12` (which is NOT
     private) gets false-positive-blocked; `172.16.0.0/12` correctly
     matches but the prefix-only check is fragile.
   - **No DNS pre-resolution.** Public hostname that resolves to
     `169.254.169.254` is fetched without re-check (rebinding).
   - **No redirect re-validation.** A 302 from a public host to a private
     IP executes the fetch unconditionally.

The weak guard's `GITHUB_RE` short-circuit path (special-cased
`api.github.com/repos/...` reads) doesn't mitigate the gaps above: an
attacker controls the URL text, not just the host.

## Decision

Adopt a **single source of truth** for SSRF guard logic:

- Extract the strong guard from `src/mcp/tools/web-fetch.ts`
  (`isPrivateIPv4`, `isPrivateIPv6`, `isPrivateIp`, `stripIpv6Brackets`,
  `SafeFetchDeps`, `assertHostSafe`, `assertUrlShapeSafe`) into a new
  module `src/core/ssrf-guard.ts` that has no dependency on the MCP
  server / HTTP transport.
- `runMemphisWebFetch` in `src/mcp/tools/web-fetch.ts` is rewritten to
  delegate to `ssrf-guard`. The exported `MemphisWebFetchInput` /
  `MemphisWebFetchOutput` types and the function signature stay the same
  so existing callers (`src/mcp/server.ts:878`,
  `src/gateway/tool-executor/domains/external-info-tools.ts:44`) compile
  unchanged.
- `isSafeUrl` and `fetchUrlsFromMessage` in `src/gateway/url-extract.ts`
  delegate to the same `ssrf-guard` module. The semantic change is that
  the gateway turn-runtime auto-fetch path now blocks the full IPv4 +
  IPv6 + DNS rebinding + redirect surface, matching what
  `runMemphisWebFetch` does for the explicit MCP tool.
- Add `tests/unit/url-extract.test.ts` regression net that asserts
  `169.254.169.254`, `::1`, `fc00::1`, `fe80::1`, IPv4-mapped IPv6,
  DNS-to-private, and public-to-private redirect are all blocked through
  the gateway path.
- Add `tests/unit/ssrf-guard.test.ts` covering the extracted primitives
  directly.

Out of scope (deliberate):

- Changing the redirect limit (`MAX_REDIRECTS = 5`) or the
  body-character cap (`MAX_BODY_CHARS = 4000`) on either path. These are
  the same numbers in both files already; consolidating them is a
  follow-up.
- Forcing `url-extract` callers (`src/gateway/turn-runtime.ts:843`) to
  honour `MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK` semantics. The
  `url-extract.ts` module already plumbs `allowPrivateNetwork` through,
  so the consolidation preserves operator opt-in for local dashboards.

## Consequences

Positive:

- One set of block-list rules. New ranges (e.g. a newly-disclosed cloud
  metadata IP) get added once and apply to both code paths.
- `url-extract.ts` gateway auto-fetch closes the metadata-service SSRF
  gap. The strongest single motivation: `169.254.169.254` and its
  peers can no longer be reached through the gateway turn-runtime path.
- Tests in `tests/unit/ssrf-guard.test.ts` document the rules and serve
  as the regression net for both paths.

Negative / risk:

- Behavioural change on the gateway auto-fetch path: URLs that
  previously fetched (e.g. `http://172.32.0.1/...` which was
  false-positive-blocked anyway) now resolve under the same rules. Any
  user who relied on the old weak guard's gaps to reach internal hosts
  through turn auto-fetch will see those fetches blocked. This is the
  intended security posture; the env override
  `MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK=true` remains available for
  operator opt-in (consistent with the strong guard's semantics).
- `web-fetch.ts` and `url-extract.ts` grow an import. Trivial.

## Implementation

### New `src/core/ssrf-guard.ts`

Exports:

- `isPrivateIp(ip: string): boolean` — IPv4 + IPv6 check, including
  IPv4-mapped re-check.
- `stripIpv6Brackets(host: string): string`
- `assertUrlShapeSafe(rawUrl: string, deps: { allowPrivateNetwork?: boolean }): URL`
- `assertHostSafe(host: string, deps: { allowPrivateNetwork?: boolean; dnsLookup?: ... }): Promise<void>`
- `SafeFetchDeps` (already defined; move verbatim).

### `src/mcp/tools/web-fetch.ts`

Replace inline private functions with imports from `../../core/ssrf-guard.js`.
Re-export `MemphisWebFetchInput` / `MemphisWebFetchOutput` so existing
imports continue to resolve. The `runMemphisWebFetch` body collapses to
importing the shared helpers plus its own HTTP-redirect / body-truncate
logic.

### `src/gateway/url-extract.ts`

Replace inline `isSafeUrl` with a call into `ssrf-guard` that returns the
same boolean. The `allowPrivateNetwork` opt-in already flows through;
preserve it.

### Tests

- `tests/unit/ssrf-guard.test.ts` — IPv4 / IPv6 / IPv4-mapped / DNS
  lookup mock / public-to-private redirect. ~30 cases.
- `tests/unit/url-extract.test.ts` — regression net for the gateway
  path: `169.254.169.254`, `::1`, `fc00::1`, `fe80::1`,
  IPv4-mapped IPv6, DNS-to-private. ~10 cases.

## Validation

- `npx vitest run tests/unit/ssrf-guard.test.ts tests/unit/url-extract.test.ts tests/unit/mcp-web-fetch.test.ts tests/unit/mcp-tools.test.ts tests/unit/mcp-tools-extended.test.ts` — all green.
- `npx tsc --noEmit -p tsconfig.json` clean.
- Manual smoke: confirm `memphis-v5.pl` URLs still auto-fetch in
  gateway turn runtime (positive case still works), and a payload
  containing `http://169.254.169.254/latest/meta-data/iam/...` is
  replaced with `[blocked: URL failed safety check]`.

## Out of scope (follow-up)

- `redirect: 'follow'` semantics for the non-MCP `fetchUrlsFromMessage`
  path — currently no follow at all; a future ADR can decide whether
  to thread redirect support into the gateway turn auto-fetch.
- Operator-facing metrics counter for SSRF blocks (`ssrf_blocks_total`
  labelled by source = web_fetch | url_extract).
- Hardening `chain-file-io.ts` write paths — separate ADR if a real
  attack surface surfaces.