# S1–S9 execution record

## E18-LAUNCH-PATHS — deployed 2026-10-18

Codex implemented and self-reviewed the explicit runtime-root path fix. TS passed
launch cwd to the shared Rust path functions while native anchored relative data
paths on runtime root. The isolated launch fixture failed seven of eight cases
before the fix; the absolute-override case already passed. Data, chains and chain
path calls now use an explicit MEMPHIS_RUNTIME_ROOT, retaining cwd behavior when
no override is supplied. No persisted format or production Rust code changed.

51 TS tests in nine files passed, zero failed/skipped. All eight launch cases ran:
clean/inherited environments from home/Work/another project, explicit absolute
overrides across fresh starts, and a real transient user-systemd service. A guarded
native example and TS child read the same synthetic encrypted v2 credential and
compare paths, provenance and generation. Shadow cwd dotenv files are ignored;
fixture env/state/entries remain byte-identical. Child fixtures explicitly exit
after flushing; this is not finalizer-stress or host-reboot coverage.

Strict private TS build, scoped lint/format and Rust-example rustfmt passed. The
.mts helper was linted through stdin using a virtual .ts filename. Exactly one JS
artifact changed and was deployed; native artifacts stayed unchanged. Two starts
healthy, invalid chain blocks=0, doctor 47/13/0/requiredFailures0, TUI OK,
NRestarts0. MiniMax HTTP200/exact MEMPHIS_S1_LAUNCH_PATHS_OK. Final source,
protected-file, index and native comparisons passed; deployed JS matches the build.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-launch-paths-_thxse11`,
verification-final.json and deploy.py --rollback. Restore this scope before
E18-INIT-RESULT and older scopes. No commit/push. This accepts local V11 launch
path cases; remaining memory and release gates are separate.

## E18-INIT-RESULT — deployed 2026-10-18

Codex implemented and self-reviewed the legacy initialization result boundary.
A synthetic compatibility bridge demonstrated private master_key_hash/error/nested
fields reaching the adapter, facade and HTTP success response. The new ten-case
fixture initially had nine failures and one pass. The adapter now validates public
version 1/2 and nonempty string identity, then constructs only {version, did}.
Malformed legacy output fails with the existing fixed initialization failure.
Private Rust serde payloads and persisted vault formats are unchanged.

69 TS tests in seven files passed, including all ten new cases, existing bridge,
double-init, boundary, HTTP and real CLI coverage. Strict TS build, scoped lint JSON
(two files, zero source errors/warnings), format and diff checks passed. One compiled
JS changed: infra/storage/rust-vault-adapter.js. The first preflight stopped before
service stop because it treated the existing ESLintIgnoreWarning as source output;
the replacement gate validates the structured ESLint report and retains the warning.

One JS artifact deployed; native unchanged. Two starts healthy, doctor 47/13/0,
requiredFailures=0, TUI OK, NRestarts=0. MiniMax HTTP200 and exact
MEMPHIS_S1_INIT_RESULT_OK. Source/protected/index/native hashes remained unchanged
through canary; deployed JS matches the verified build. No real vault initialization
or credential reset was used as a test. No commit/push.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-init-result-48rmh49r`.
verification-final.json records the final proof; deploy.py --rollback restores the
single previous JS. Roll back this change before E18-NATIVE-DEBUG and older slices.
Full S1 acceptance is still open.


## E18-CLI-ERRORS — deployed 2026-10-18

Codex implemented and self-reviewed fixed public failures for secret add/get/list.
Known state/entry/bridge codes survive; arbitrary messages, nested causes and
getters do not. JSON failures are structured. Failed operations and missing get
return exit 1; successful empty lists remain exit 0. Existing critical exit status
and known hardening exits 101–103 survive. Authentication and required-argument
validation precede this operation mapper and retain their existing behavior.

37 TS tests in three files passed: 23 unit, five real child-process handler cases,
and nine shared reader cases. Child fixtures guard isolated paths before imports;
they establish only an in-memory session and do not change operator configuration.
They explicitly exit after flushing, so do not establish full launcher/finalizer
stress behavior. Strict typecheck/build, scoped lint/format and compiled comparison
passed; one CLI JS artifact deployed, native unchanged.

Two starts and an additional fresh restart were healthy; doctor 47 pass / 13 warn /
0 fail / 0 requiredFailures, TUI OK, NRestarts=0. MiniMax attempts were HTTP 500,
200, 200; both successful attempts returned the exact MEMPHIS_S1_CLI_ERRORS_OK
marker, including the first request after the additional restart. The initial 500
is retained; available journal metadata only says INTERNAL_ERROR. Its cause is
unconfirmed. This establishes a locally working deployment, not the full release
observation gate. Protected files, immediate predeploy index and native hashes
matched after canary. No commit/push.

Evidence and rollback: `/home/memphis/.memphis-backup-s1-cli-errors-kn75azc3`;
verification-final.json contains all three canary outcomes. Roll back CLI errors
before E18-READERS and earlier deployment slices.

## E18-NATIVE-DEBUG — deployed 2026-10-18

Codex implemented and self-reviewed ten explicit safe Debug projections in five
Rust files: embedding/operator configuration, secret view, vault configuration,
init request/result, store request, retrieve result, entry and recovery challenge.
Ten synthetic regression tests failed before and passed after the change.
Serde, Clone, Eq and intentional private payload access remain compatible; tests
check wire compatibility and recovery verification. No persisted credential format
was changed, and no active credential exposure is asserted.

The isolated offline full Rust workspace run passed 475 tests, with zero failures
and two ignored cases across 27 result reports. Rust sources and protected files
were unchanged. The Git index changed semantically during that run (50 paths;
author unknown); it was preserved, not restored. Thus cargo success is established,
but the combined workspace proof's index check failed. Before building, all Rust
source hashes still matched the tested snapshot. A fresh frozen acceptance captured
the current index and source state. Private NAPI/TUI/example build, typecheck and
577 TS tests in 86 files passed (zero failed/skipped). Rust sources, TS sources,
protected files and the fresh index baseline remained unchanged. The two ignored
Rust cases are a BASAL-dependent integration and an ignored documentation example.

Two native artifacts deployed, no JS change. Both service starts were healthy,
invalid chain blocks=0, doctor 47 pass / 13 warn / 0 fail / 0 requiredFailures,
TUI OK, NRestarts=0. MiniMax returned HTTP 200 and the exact
MEMPHIS_S1_NATIVE_DEBUG_OK marker. After canary, source/protected/index hashes
matched and both deployed native artifacts matched the tested private copies.
Scoped rustfmt passed for all five changed files. Full workspace formatting
still reports pre-existing differences outside this scope; the staged whitespace
check reports an existing AGENTS.md blank line at EOF. These are not claimed green.
No commit/push. Rollback: deploy.py --rollback in this scope; restore this pair
before rolling back CLI errors or earlier native/JS slices.

Evidence: `/home/memphis/.memphis-backup-s1-native-debug-4htu6p5v`.

## E18-READERS — deployed 2026-10-18

Codex implemented and self-reviewed consistent reader failure classification.
One encrypted fixture exercises named/raw/bounded facades, HTTP, CLI, MCP and a
fresh native Rust reader. Five initial cases failed while the readable case
passed; raw/HTTP/CLI lost the code already reported by Rust/named/MCP. A separate
missing-state case demonstrated bounded-use also losing it. The common facade now
reconstructs state/entry/bridge codes; raw/bounded failures carry errorCode, HTTP
maps it to code and CLI get --json returns structured read failures. MCP declares
its existing errorCode field. Unknown/tampered codes and nested context are not
published. Authorized readable exports intentionally preserve plaintext behavior.

75 distinct TS cases in eight files passed: 74 in the main run, plus the added
missing-stored-key case. The final nine-case fixture rerun overlaps eight earlier
cases; do not add 74+9. It also covers unsupported version/missing pepper, and
shows explicit supplied-entry decrypt still works when no stored key exists.
Native fixture calls are part of the TS cases, not new Rust unit-test counts.
Authorization is mocked for CLI/MCP in that fixture; separate policy suites remain
the authorization evidence. Five added unit cases cover state/entry/bridge/unknown/
tampered classification. Existing provider/wallet/config/managed-app tests passed.

Strict TS build, scoped lint/format/diff passed. Five JS artifacts deployed:
three functional (boundary, HTTP vault, CLI secret) and two comment-only (config
resolution/apps). AST equality and manual diff confirm comment-only changes; an
initial raw scanner comparison failed and is not acceptance evidence. The comments
now state that trusted callbacks can retain/return plaintext. MCP's type-only
change emits no JS delta. No native change. Two starts healthy, invalid=0; doctor
47/13/0, requiredFailures=0, TUI OK, NRestarts=0. MiniMax HTTP 200 and exact
MEMPHIS_S1_4_READERS_OK. Protected files, predeploy index and native hashes unchanged
through canary. No commit/push. This scope did not yet change CLI exit status.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-reader-surfaces-ftm_zdu0`. Roll back readers before atomic/HTTP-audit/H3/wallet/
earlier audit/aliases/cache. See the [reader inventory](S1-CREDENTIAL-READERS.md).
Full S1.4/S1.7 and V01–V04/V11 acceptance remain open.

## E18-ATOMIC — deployed 2026-10-18

Codex implemented and self-reviewed private atomic-write cleanup diagnostics.
Three failing regressions exposed raw unlink exception/path warnings and a
secondary descriptor close error replacing the original write failure. Cleanup
now preserves the primary failure, emits only fixed operation/errno, and tolerates
a warning-write exception. The common closed errno helper is reused by the audit
recorder without invoking getters; no credential lifecycle or crypto format change.
A failed unlink leaves its private temporary for recovery; no cleanup success is
invented. The descriptor-close fixture really closes the fd before forcing EIO.

51 distinct TS tests in six files passed, including both encrypted rotations,
publication failures, fresh recovery processes, HTTP readers and audit getter/proxy
cases. The earlier 37 cases overlap; the additional fourth atomic case forces
stderr failure. Lint initially required import ordering; an extra blank left by
eslint --fix failed the format preflight BEFORE service stop/artifact mutation.
Prettier, final scoped lint/format, strict TS rebuild and source-hash refresh passed.
Deployed private-atomic-file.js, security-audit.js and new io-error-code.js; rollback
installs/restores importers before removing the new helper. No native changes.

Two starts healthy, invalid=0; doctor 47/13/0, requiredFailures=0, TUI OK,
NRestarts=0. MiniMax HTTP 200 and exact MEMPHIS_S1_7_ATOMIC_OK. Protected files,
predeploy index and NAPI/TUI hashes unchanged through canary. No commit/push.
Evidence/rollback: `/home/memphis/.memphis-backup-s1-atomic-errors-50z0o5x6`. Roll back atomic before HTTP/audit, H3, wallet, earlier
audit, aliases and cache. Full S1 and durability/power-loss gates remain open.

## E18-HTTP-AUDIT — deployed 2026-10-18

Codex implemented and self-reviewed safe HTTP vault error projections and recorder
stderr. Init/encrypt/decrypt/entries use fixed fallback errors; state/entry/bridge
codes are reconstructed from known classes. Already-initialized errors retain 409
and a fixed preservation message. Validation audit exceptions are wrapped without
the original cause, protecting Fastify's default response and logger too.
Recorder write/rotation warnings expose only whitelisted errno or AUDIT_WRITE_FAILED,
never the exception message/cause/action/path. Its existing best-effort behavior
remains: ordinary I/O failures are swallowed after a warning. The transport tests
force an unexpected dependency exception; they do not establish ordinary append
failures propagating to HTTP. All sentinel values are synthetic.

69 distinct TS tests in ten files passed (45 transport/boundary/audit/route; 24
policy/auth/double-init). Earlier 20/41 runs overlap. Six initial HTTP assertions,
a separate metadata response/log check, three invalid-payload logger fixtures and
six recorder stderr cases reproduced the gaps before their fixes. Getter/proxy
cases guard error inspection. Initial lint found one import-order issue; fixed,
then final scoped lint/format/diff passed. Strict TS build passed. Two JS artifacts
only (HTTP vault routes, security-audit), no native change. Two starts healthy,
invalid=0; doctor 47/13/0, requiredFailures=0, TUI OK, NRestarts=0. MiniMax chat
HTTP 200 and exact MEMPHIS_S1_7_HTTP_AUDIT_OK. Protected files and immediate
predeploy index unchanged through canary. No commit/push.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-vault-http-zcnc_r3w`. Roll back HTTP/audit before H3/wallet/audit/aliases/cache.
S1.7 and full S1 acceptance remain open. A further isolated regression found raw
private-atomic cleanup warnings and a secondary close error replacing a primary
write error; that next scope is not included in this deployed artifact set.

## E18-H3 — deployed 2026-10-18

Codex implemented and self-reviewed a further S1.7 public-output fix. H3 no longer
returns provider error bodies, network exception text or arbitrary nested response
data. Public task ID/status/HTTPS video URL remain, including a compatibility data
field containing only those metadata. It rejects userinfo/non-HTTPS URLs and known
credential echoes in allowed fields (raw, common encodings, SHA-256 and selected
16-character fragments). This is a bounded guard, not proof against arbitrary
transforms. Requests reject redirects and retain the dedicated video credential;
chat credentials are not a fallback. Error bodies are cancelled without publication.

33 distinct TS tests passed: 21 H3 and 12 registry. Fourteen initial contract
assertions failed before the fix (not fourteen distinct secret disclosures).
Coverage includes nested/raw/HTTP failure sentinels, successful metadata projection,
allowed-field echoes, malformed responses, missing credential and actual timer-driven
abort. Earlier 29-test run overlaps the final total. Strict TS build, scoped lint,
format and diff checks passed. Only mcp/tools/minimax-h3.js deployed; no native
artifact changed. Two starts healthy, invalid=0; doctor 47/13/0, requiredFailures=0,
TUI OK, NRestarts=0. MiniMax chat HTTP 200 and exact MEMPHIS_S1_7_H3_OK; no paid
H3 generation or real video API call was performed. Protected files and immediate
predeploy index unchanged through the canary. No commit/push.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-h3-gdz4mucv`. Roll back H3 before wallet/audit/aliases/cache.
S1.7 remains open: complete remaining transport sentinel inventory; HTTP vault
catch blocks still expose arbitrary error.message if an unexpected dependency
(such as audit persistence) throws beyond the safe facade.

## E18-STORAGE — verified 2026-10-18

Codex added and self-reviewed V02 publication-failure acceptance on isolated,
actually encrypted v2 fixtures. Eight cases cover pepper/master-key rotation,
first/second target, simulated ENOSPC after a partial temporary write and actual
EACCES on an unwritable directory as the unprivileged user. Failed targets keep
the original bytes and temporary files are removed. Two fresh processes per case
recover the journal and independently decrypt the credential; the second recovery
is a no-op. DID bytes remain unchanged; pepper-only rotation preserves entry bytes.
The fixtures never point at the operator vault. Permission cases explicitly skip
on root/Windows, where chmod would not establish the same denial; none skipped here.

26 distinct TS tests passed across the new fixture (8) and existing configuration
transactions (18). The final portable fixture rerun passed all eight; it overlaps
the earlier total. Scoped lint and formatting passed. Protected hashes and index
unchanged. No runtime source/artifact changes or deployment; current service stays
on E18-WALLET. Evidence: `/home/memphis/.memphis-backup-s1-storage-faults-u3_7bipj`.

This adds TS target-publication failure evidence to V02. It does not establish
physical disk capacity exhaustion, SQLite journal ENOSPC, native publication I/O
fault injection, fsync/power-loss behavior or full S1 acceptance. Retain the earlier
SIGKILL and cross-process recovery evidence separately; do not add overlapping
suite counts as unique coverage. No commit/push.

## E18-WALLET — deployed 2026-10-18

Codex implemented and self-reviewed a further S1.7 slice. Wallet signing now
projects vault/signer failures to fixed public messages, omits private seed
lengths, and zeroizes decoded seed/PKCS#8 buffers in finally. Public signatures,
public keys and signed-message hashes keep their documented meaning. The trusted
vault callback contract is unchanged. No real transaction was signed for testing.

Four added sentinel cases failed before the fix; all 16 tests across wallet-sign
and the independent-reference fixture passed afterward. Strict TS build, scoped
lint/format and diff checks passed. Compiled comparison selected exactly
mcp/tools/wallet-sign.js; no native artifact changed. Both service starts healthy,
invalid=0; doctor 47 pass / 13 warn / 0 fail / zero required failures, TUI OK,
NRestarts=0. MiniMax HTTP 200 and exact MEMPHIS_S1_7_WALLET_OK. Protected files
and the immediate predeploy index stayed unchanged through the canary.
Evidence/rollback: `/home/memphis/.memphis-backup-s1-wallet-uc49tyxh`. Roll back wallet before audit/alias/cache artifacts.
No commit/push. Full S1.7 remains open for H3 and the complete public sentinel matrix.

## E18-PROSE — local triage 2026-10-18

Codex inspected current files, staged blobs and 1,322 locally reachable commits.
No checked active credential candidate matched. The maintained AGENTS.md notice
and only its staged notice were sanitized; all other staged entries and existing
staged AGENTS content outside that notice were preserved. This intentional index
mutation occurred after the E18-WALLET canary/index check. No history rewrite,
active credential rotation, commit or push. Current Synjar account status and
remote visibility are not independently verified; the old rotation claim stays
dated. See the [sanitized record](../../postmortems/2026-10-18-credential-prose-triage.md)
and private evidence `/home/memphis/.memphis-backup-s1-prose-w34xnvt2`.
The final scan passed: 2,237 current files, 2,232 index text blobs and 918,223
patch lines; zero active credential matches or current worktree/index findings.
Six historical patch occurrences remain classified privately. S1.8 local triage
is accepted, without claiming remote history cleanup or current account validity.

## E18-AUDIT — deployed 2026-10-18

Partial S1.7 and a reopened S1.2 reload guard are locally deployed. Audit fields
now use fixed classifications, typed counters/flags and validated IP addresses.
Initialization and CLI master-key rotation expose fixed errors without raw causes;
native ProviderRuntime Debug excludes credentials and configuration values.
Config output masks unknown values and URL credentials/query/fragment, including
malformed URL fields. Generic reload rejects a changed pepper even with allowCold;
public hook failures expose CONFIG_HOOK_FAILED and rejected reloads report zero
applied changes. The pepper was already classified secret; the earlier suspicion
about that classification was disproved and did not motivate a registry change.

119 distinct TS cases across 19 files and one Rust Debug sentinel passed.
One integration expected the former raw hook exception; its updated safe-code
assertion passed on rerun. Counts exclude overlapping reruns. Strict TS build,
native TUI build, scoped lint, formatting and diff checks passed. Five JS files
and TUI were deployed while stopped; NAPI and the vault format stayed unchanged.
Both starts healthy, invalid=0; doctor 47 pass / 13 warn / 0 fail / zero required
failures; TUI OK, active service, NRestarts=0. Real MiniMax returned HTTP 200,
providerUsed=minimax and exact MEMPHIS_S1_7_AUDIT_OK. Protected files and the
immediate predeploy index stayed unchanged after the canary. No commit/push.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-audit-rfqhtiue`.
Rollback this scope before E18-ALIASES and E18-CACHE. S1.7 remains open: legacy
wallet/H3 public error/result surfaces still need review and synthetic sentinels.
The trusted callback may return/throw its input; safe projection belongs at each
public boundary. S1.8 prose/history triage and full sprint/release gates remain open.

## E18-ALIASES — deployed 2026-10-18

Codex implemented and self-reviewed S1.6 after E18-CACHE. One shared JSON fixture
covers MiniMax, DeepSeek, GLM and Anthropic across default/custom references,
padding, replacement, removal, corrupt latest entries and explicit plaintext use.
Native now trims references, rejects implicit plaintext fallback when the selected
entry is missing, and preserves its existing OAuth-refresh-token restriction after
normalization. Missing Anthropic credentials no longer report configured=true.
TS conflict diagnostics distinguish an unreadable credential from a missing entry.

43 TS tests in five files and ten Rust selector tests passed. Regressions exposed
three gaps; the initial failing/poisoned runs are retained separately. Strict TS
build, native TUI build, scoped lint, formatting and diff checks passed. Deployed
only providers/index.js and TUI while stopped; NAPI/storage format unchanged.
Both starts healthy, invalid=0; doctor 47 pass / 13 warn / 0 fail / 0 required
failures; TUI OK; active service, NRestarts=0. Real MiniMax returned HTTP 200 and
exact `MEMPHIS_S1_6_ALIAS_OK`. Protected hashes and the immediate predeploy index
stayed unchanged after the canary. No commit/push; mixed work remains preserved.

Evidence/rollback: `/home/memphis/.memphis-backup-s1-alias-l_m43f6t`.
Rollback newer alias artifacts before the earlier cache set. S1.6 locally accepted;
S1.4, S1.7–S1.8 and full sprint/release gates remain open.

## E18-CACHE — deployed 2026-10-18

Codex implemented and self-reviewed S1.5 plus the remaining metadata publication
bug in S1.4. Base HEAD remains `10fac3d8`; this slice is locally deployed and
uncommitted. The preserved mixed checkout is the build input; independent review
and a clean release revision are not claimed.

- TS immediately zeroizes/evicts its derived key after accepted reloads and
  invalidates on state/config identity changes or failed loads. No-op, rejected
  and dry-run reloads keep it. Native retains one SHA-256-identified generation;
  `Vault::drop` zeroizes the key. Entries are reread instead of caching plaintext.
- Native now captures state under the journals, derives outside the locks and
  checks identity again before entry selection/decryption. The two warm-reader
  regression exposed a lock timeout in the initial implementation; fixed.
- List/latest/metadata/startup readers recover a pending publication before
  interpreting the entry set as empty. Four failing regressions now pass.
- ARCHITECTURE records the pivot from a proposed shared numeric counter to
  persisted byte identity plus an explicit process-local epoch. External pepper
  rotation requires restart; an explicit stale env override is not overwritten.

Validation: **99 distinct TS tests across 16 files** (23 lifecycle/config;
69 surfaces, including one isolated successful retry after an overloaded-run
30 s timeout; 7 process snapshots/races). **187 distinct Rust tests** (51 vault,
135 operator in a complete package run, plus one added entry-cache test); one
BASAL-dependent case ignored. These are affected suites, not the full TS suite
or Rust workspace. Earlier fixture/failure logs remain retained. Typecheck,
TS/NAPI/TUI builds, changed-file lint/format and diff checks passed. The tested
NAPI equals the final artifact byte for byte.

Three JS artifacts (hot-reload, rust-vault-adapter, vault-entry-store), NAPI and
TUI were replaced while stopped. Both starts were healthy, chain invalid=0;
after the second start doctor **46 pass / 14 warn / 0 fail / 0 required failures**,
TUI ok=true and NRestarts=0. The additional warning versus October 17 is optional
GLM connectivity. MiniMax returned HTTP 200, providerUsed=minimax and the exact
`MEMPHIS_S1_5_CACHE_OK` marker. Protected dotenv/vault/DID hashes stayed unchanged.
The index immediately before deployment stayed byte-identical through the canary;
an earlier index change was preserved separately rather than reset.

Private evidence and complete artifact rollback:
`/home/memphis/.memphis-backup-s1-cache-hhvr3j_t` (`verification-final.json`,
source hashes, test logs, old/new artifacts, `deploy.py --rollback`). No commit
or push. S1.5 is accepted in the recorded contract. Full S1 and release gates
remain open. Next: S1.6 alias/fallback parity; native currently permits a missing
explicit vault reference to fall back to plaintext while TS reports conflict.

## Earlier execution status — reconciled 2026-10-17

Implementation is authorized. The local recovery and successive S1 slices are
running; S1–S9 are not accepted as complete. The active backlog is
[SPRINTS.md](SPRINTS.md#s1-completion-queue), and the acceptance gaps are recorded
in [VALIDATION.md](VALIDATION.md#earlier-acceptance-status--2026-10-17).
The detailed [handoff](../../../notes/next-session-memphis-recovery-2026-10-14.md)
retains commands, failure explanations and private artifact locations.

The source baseline is `10fac3d81901892001d8634c754e42a333659fca` on
`fix/embed-persistence-and-chain-parse`. That selected vault/config/reader commit
was pushed to `elathoxu-crypto/memphis-fork` on October 17. The current deployed
build also includes local work. In particular, E17-SNAPSHOT is deployed but
uncommitted. Earlier staged and unstaged work is still mixed and must be preserved;
the whole checkout must not be described as that single commit.

| Evidence ID     | Verified scope                                                                                                                                                                 | Acceptance limit / reference                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| E15-RECOVERY    | Matching state/pepper restored while retaining entries, DID and memory; test paths isolated; TS/Rust artifacts deployed.                                                       | [Isolation postmortem](../../postmortems/2026-10-15-vault-test-isolation.md). No host reboot or complete recovery-release acceptance. |
| E15-ROTATION    | Journal validation and six real encrypted pepper/master-key SIGKILL cases, fresh-process recovery and repeated startup.                                                        | Commits `96cd41c7` / `3501e68d`; V02 still needs disk-full/permission evidence.                                                       |
| E15-CONCURRENCY | Serialized entry writes, native read snapshots and initialization; stale writes rejected, interrupted init recoverable.                                                        | Commits `0cb8869d`, `67541c0e`, `0863ec21`; no full S1 cache/config acceptance implied.                                               |
| E16-CONFIG      | Shared current/legacy journal selection, pepper mutation guard under locks, path provenance, launcher/native agreement and bootstrap/reload generation lifecycle.              | Handoff sections dated October 16. The numeric generation remains process-local; S1.5/V11 must address cross-process semantics.       |
| E17-READERS     | Shared Rust v1/v2 state parser and entry selection/decoding; TS/NAPI/native parity, safe error codes, legacy tags/metadata, corrupt-store refusal.                             | Handoff reader sections; selected changes included in `10fac3d8`. Remaining facade/cache gates stay open.                             |
| E17-SNAPSHOT    | By-key secret reads, bounded use and boot integrity probe select and decrypt one recovered state/entry generation. Two new process races cover concurrent master-key rotation. | Latest local deployment, detailed below; raw-entry/metadata and full cross-surface acceptance remain to reconcile.                    |

### E17-SNAPSHOT verification and deployment

- 76 distinct TS tests in nine files passed in strict mode: 70 in the surfaces
  run, the corrected single authentication-timeout case, and five process tests.
  The initial failed runs are retained in the evidence directory. The test mock
  hoisting error was corrected; reader/writer fixtures now seed synthetic state
  while retaining real native crypto; the multiple-KDF authentication case has
  a 90-second bound. No whole-suite or new Rust-suite claim is made.
- Typecheck, TS build, changed-file lint, formatting and diff checks passed.
  The compiled delta was exactly `infra/storage/rust-vault-adapter.js`,
  `infra/storage/vault-entry-store.js` and `security/vault-boundary.js`.
  Native artifacts were unchanged.
- Two controlled service starts returned healthy. After the second: doctor
  47 pass / 13 warn / 0 fail / 0 required failures; native TUI `ok=true`;
  service active and `NRestarts=0`; MiniMax HTTP 200 with the exact requested
  `MEMPHIS_S1_4_SNAPSHOT_OK` marker.
- Configuration, vault state/entries and DID hashes stayed unchanged after the
  canary. The original Git index was preserved. No commit or push for this slice.

Private evidence and rollback files:
`/home/memphis/.memphis-backup-credential-snapshot-vfpr6y2u`.
`source-hashes.json`, `compiled-changes.json`, `verification-final.json`,
`verification-deployed.json`, `tests-*.log` and `changes.patch` identify the
verified scope. `dist-before/` contains the three replaced artifacts. Revert
those artifacts together with the service stopped if needed; retain current
vault/configuration data. Do not replace unrelated build files from an older
full-tree backup.

### Planning reconciliation — 2026-10-17

Codex reconciled README, SPRINTS, EXECUTION, VALIDATION and ARCHITECTURE with the
handoff and saved reports. Read-only live check: active/running, `NRestarts=0`,
API healthy, chain integrity ready with zero invalid blocks. Synjar at port 6200
was unavailable. This reconciliation adds no runtime implementation, deployment,
test-suite run or acceptance closure. Formatting, local links and document
consistency are checked separately from runtime acceptance. The original index
is preserved.

The immediate sequence is remaining S1.4 acceptance → S1.5 cache/config lifecycle
→ S1.6 alias parity → S1.7/S1.8 output/history handling → V01–V04/V11 sign-off.
Then continue S2 → S4 → S3 → S5 → S6 → S7 → S8 → S9. Existing partial patches
must be reviewed and reused before new implementations are added.

## Historical execution records

The entries below describe their recorded dates. Statements that code did not
compile, that a daemon predated a patch, or that a later-implemented feature was
missing must not override the current status above.

## Concurrent initialization — 2026-10-15

Commit `0863ec21` serializes vault initialization with the configuration journal
and rejects unreadable state or orphaned/malformed entries. A real two-process
regression reproduced double success before the fix; the corrected case preserves
the first key and decrypts its entry from a fresh process. SIGKILL before
publication permits a subsequent successful initialization.

Strict Vitest: 114 tests in 19 files passed. Typecheck, TypeScript build and
changed-code formatting passed; full lint: zero errors, three warnings. The built
adapter was the only changed deployment artifact. Following local deployment
and restart: API healthy, 79 checked blocks, zero invalid, NRestarts=0; MiniMax
HTTP 200 with the requested marker; native TUI preflight passed without snapshot
errors; doctor 46 pass / 14 warn / 0 fail. The additional optional warning versus
the previous check is query latency (1.995 ms, target below 1 ms). Protected env,
vault and DID hashes and unrelated Git index entries were unchanged. No push.

Evidence and previous dist: `/home/memphis/.memphis-backup-vault-init-dwh11_25`.
Shared journal selection/config provenance across standalone launches and full
S1 acceptance remain open. Earlier observations below are historical.

Implementation started on operator request. This is a working record, not a release declaration. The original acceptance gates remain authoritative. Changes are in the shared checkout, alongside previously existing changes; no deployment, commit or release has been performed for these patches.

## Initial slices under validation — historical October 12 inventory

- S1: initialized-vault pepper guard for generic config set/unset; custom provider vault references; distinct missing/decrypt-error results; private atomic configuration writes; canonical explicit env path for enrollment/rotation; cache invalidation on vault path, encrypted file content and pepper; fixed audit field allowlist, no new plaintext hashes; correct trusted-callback documentation.
- S2: derive all 22 native tool policies from actual catalog/dispatch; require shared registry or explicit native-only metadata; reject unclassified additions and unknown tool execution; remove blanket global-tier escalation advice.
- S4: isolated extraction drill with actual chain/hash and SQLite integrity validation; reject archive links/special files; preserve previous archives after a failed drill; persist scheduler backup evidence and recognize the cron authority; failed drill marks cron execution failed.
- S5: stored operator recovery configuration recognized without plaintext env answers; shared scheduler status vocabulary including pending/running/skipped/timed_out.

## Initial verification — historical October 12 results

- TypeScript typecheck passed after initial S1/S2 patches; re-run required after later edits.
- Initial vault/config/provider suites passed. Added sentinel, alias, cache and generic-write regression tests.
- Native shared tool-tier regression passed after compiling memphis-operator.
- Backup content drill: valid archive passes, checksum-valid corrupt SQLite fails, source remains unchanged. Existing scheduled backup unit tests passed before state-persistence changes.
- Recovery configuration/status contract tests passed.

## Initial remaining gates — historical, superseded by the current queue

S1 is not complete: recoverable multi-file rotation, shared Rust credential facade and cross-surface config generations still require implementation and fault-injection tests. S2 is not complete: explicit subject/session grants and generated full interface metadata remain. S3 and S6–S9 have not been completed. S4 still requires consistent complete snapshots, protected credential bundles and full restoration of identity/credentials. S5 still requires canonical embedding metadata and complete diagnostic service extraction.

No claim is made for a reboot, VM installation, full restoration, production canary, 50% token reduction, or completion of any S1–S9 sprint.

## Handoff note for the next session (2026-10-12, written by Memphis)

Read-only review of the working tree. No code was changed. The four points below
were measured on this host at 2026-10-12 20:44 CEST. None of them appear in
AUDIT.md, ARCHITECTURE.md or SPRINTS.md.

### 1. TypeScript does not currently compile

```
npx tsc --noEmit -p tsconfig.json
src/providers/diagnostics.ts(51,127): error TS2322:
  Type 'ProviderProbeResult' is not assignable to type 'Record<string, unknown>'
```

One error, in `finish()`, which passes `details: result` to
`writeSecurityAudit`. `ProviderProbeResult` has no index signature. The "typecheck
passed" line under "Verification so far" was true of the moment it describes and
is no longer true of the current tree. Everything from S1/S3 sits behind that
import, so nothing downstream typechecks either.

### 2. The running daemon predates every change from this session

| Artifact                                   | Timestamp        |
| ------------------------------------------ | ---------------- |
| `dist/index.js`                            | 2026-10-12 01:09 |
| newest `src/**/*.ts`                       | 2026-10-12 19:50 |
| `memphis.service` `ExecMainStartTimestamp` | 2026-10-12 12:18 |

The service answering on `127.0.0.1:3000` runs a build roughly 19 hours older than
the current source. `writePrivateAtomicFile`, `ProviderHttpError`, the pepper
guard and the audit allowlist have never been executed by the service. That is not
a defect in them — it is why this document makes no runtime claim about the
current tree. The first restart after a successful build is where that becomes
observable, and S0's history says a stale in-memory cache can hide exactly this
class of problem until restart.

### 3. `crates/memphis-operator/src/context.rs` needs a second look before S6.5 counts as done

`provider_context()` replaces a duplicate `memphis_code_read` / `grep` / `glob` /
`chain_query` / `recall` / `search` result over 1024 bytes with:

```
[Exact duplicate read result. Full identical content retained at tool_call_id=<id>.]
```

The most recent occurrence keeps its full body, so the unit test passes and the
lossless claim holds for the window exactly as supplied. The open question is what
happens when the retained occurrence is no longer in that window: native chat holds
up to 10,000 messages and compaction is a separate TS path. A pointer to a
`tool_call_id` that has been compacted away reads as recoverable but is not, and
fails silently. Worth settling against the S6.3 compaction path before the 50%
input-token target is treated as met, and worth naming the authoritative
occurrence in the tool result itself.

### 4. `memphis_vault_list` is classified tier 0

`src/gateway/native-tool-policy.ts` gives it `tier: 0, capabilities: ['read']`. Its
arm calls `runtime.snapshot()` → `load_vault_summary()`, which reads state but does
not decrypt; `credential.probe` is the operation that runs Argon2id (65 MiB, three
passes) per call. Tier 0 therefore means "no authorization" for the cheap call,
while the expensive one has no native arm yet. ARCHITECTURE.md already separates
`credential.inspect`, `credential.probe` and `provider.probe` — when S3.1 lands,
confirm the tier that arrives with each instead of inheriting tier 0 from the
inspect operation.

### Also worth noting

- 75 changed paths, no commit. The staged/unstaged/untracked split is mixed, and
  `null` — an empty 0-byte file — is staged. README.md rule 2 asks for a baseline
  commit and a named owner for pre-existing changes before code work starts; that
  has not happened, so `git checkout .` would discard roughly 1,900 lines of
  uncommitted work. A WIP commit costs nothing and stays reversible.
- `memphis_vault_list` is the one native tool absent from `TOOL_REGISTRY`;
  `NATIVE_ONLY_TOOL_POLICY` is the right home for it, and deriving policy from
  actual catalog and dispatch beats the old hand-maintained ten-name list.
- The F09 fix (`vaultRef` instead of `mapping.vaultKey`) and `ProviderHttpError`
  are genuine improvements. Both are currently unreachable from the running service
  for the reason in point 2.
- Reviewing the S3 response shape against the ARCHITECTURE DTO: the current
  `provider.probe` returns the right outcomes and the right redirect and quota
  handling, and drops the credential-derived length, prefix, suffix and plaintext
  hash that the earlier proposal carried. That part of ARCHITECTURE.md is
  implemented as written.

## Recovery deployment — 2026-10-15

See [updated handoff](../../../notes/next-session-memphis-recovery-2026-10-14.md)
and [postmortem](../../postmortems/2026-10-15-vault-test-isolation.md).
TypeScript/Rust builds and targeted lint passed; 202 TS tests and 444 Rust tests
passed, two Rust tests ignored. Local artifacts deployed with rollback copies.
Doctor: 47 pass / 13 warn / 0 fail. TUI preflight passed. API healthy and existing
chain integrity ready (78 checked, zero invalid). Full TS suite, host reboot and
S1–S9 acceptance remain outstanding. Existing mixed staged work was preserved;
no commit or push was made during recovery.

## Encrypted rotation recovery — 2026-10-15 continuation

Commit `3501e68d`: actual pepper/master-key operations recover after SIGKILL
before and after target publication using the native encryption bridge. Six
crash scenarios and 52 adjacent regressions passed. TypeScript build and full
lint passed (three lint warnings). Deployed with rollback artifacts in
`/home/memphis/.memphis-backup-rotation-lsb_tw25`. After restart: API healthy,
79 checked blocks / zero invalid, real MiniMax HTTP 200, TUI preflight passed,
doctor 47 pass / 13 warn / zero fail. Live dotenv, vault and DID hashes unchanged.
S1 still needs concurrent lifecycle writers and native/TS config/cache review;
no power-loss or host-reboot acceptance is claimed.

## Concurrent entry writes — 2026-10-15

Commit `0cb8869d` rejects pre-rotation ciphertext at save, serializes append/delete
with rotation and prevents malformed entry JSON from being overwritten. The
stale-entry regression failed before the patch and passed after it. 108 tests
in 17 files passed, including native multiprocess writers and crash recovery.
Build and full lint passed (three warnings); deployed and restarted. API,
MiniMax, doctor and TUI passed. Live config, vault and DID hashes unchanged.
Remaining S1 gates include native read snapshots, consistent journal/config
selection and concurrent initialization. See the updated recovery handoff.

## Native vault snapshots — 2026-10-15

Commit `67541c0e` adds shared-journal coordination to Rust secret, provider and
metadata reads, explicit pending-recovery errors, and pinned dotenv selection
in the TUI launcher. Cross-process regression reproduced mixed-generation
decryption failure before the patch. Two TS/Rust process tests and six launcher
tests pass; full Rust workspace: 447 passed, two ignored. Rust/TS builds and
full lint pass (three lint warnings). Deployed native TUI and dist; new preflight,
doctor, API and live MiniMax passed. Existing interactive TUI sessions were not
terminated. Runtime env, vault and DID hashes unchanged. Recovery artifacts:
`/home/memphis/.memphis-backup-native-vault-kr32jwxf`.
The commit excludes pre-existing staged embedding/launcher changes. Standalone
configuration discovery and concurrent initialization remain S1 follow-ups.
