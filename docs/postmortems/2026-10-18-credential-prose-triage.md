# Credential prose/history triage — 2026-10-18

Codex performed and self-reviewed a local S1.8 inventory. No independent review,
remote repository visibility check or current Synjar account verification is claimed.

The initial scan covered 2,236 regular current Git files, 2,232 index text blobs and
918,223 patch lines across 1,322 locally reachable commits; 120 binary inputs
were skipped. It compared the matching private recovery snapshot with active
dotenv credentials, the vault master key and both decrypted vault entries.
Comparisons included exact values, JSON/base64/hex representations, SHA-256 and
selected 16-character fragments. This finite inventory is not proof against every
encoding or shorter fragment. Live protected files and the mixed index remained
unchanged during the scan. Runtime memory and append-only audit were not rewritten.

No active credential candidate matched. Initial classifier hits were a non-secret
execution policy list and a password placeholder; both were triaged without
printing values and excluded from the final credential classification. No active
credential rotation is justified by those findings. This conclusion concerns the
credentials available in the checked local snapshot.

A known historical Synjar password fragment remained in AGENTS.md's security
notice and its index/history. The maintained worktree notice is now sanitized.
The earlier notice stated that the password was rotated in April; the local
Synjar service is unavailable, so that dated statement is not independently
revalidated. Historical matching revisions are identified only in private reports.
History was not rewritten. After the runtime canary, only the notice in the staged AGENTS.md blob was
sanitized. All other staged entries and pre-existing staged AGENTS content outside
the notice were verified unchanged. Both original and updated index snapshots are
private; selective-index-redaction.json records the bounded mutation.

Private evidence and original notice:
`/home/memphis/.memphis-backup-s1-prose-w34xnvt2` (directory mode 0700).
Reports contain locations/categories only, never matching text or credential
hash values. The before-redaction scan is retained separately. The completed follow-up scanned
2,237 current regular files with the same index/history counts: zero active
credential matches and zero worktree findings; the old index and historical
fragment remain classified separately. Protected hashes and index were unchanged.
The final scan after staged-notice redaction completed with the same counts:
zero active credential matches and zero findings in either current worktree or
index. Six historical patch occurrences remain in private reports; they do not
represent six distinct credentials. The index stayed unchanged during that scan.
S1.8 local triage is accepted; it does not certify remote history cleanup. Current Synjar rotation
status remains a dated, unverified claim if that account returns to scope. No commit, push or forced history update.
