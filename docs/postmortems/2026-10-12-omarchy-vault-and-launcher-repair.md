# Memphis vault and Omarchy launcher recovery

Incident: 2026-10-11. Local repair and verification: 2026-10-11–12.

## TL;DR

`memphis.service` refused startup with exit 102 because the configured pepper could not authenticate the persisted v2 vault state. Existing local env backups contained a matching pepper; both state and the existing MiniMax entry decrypted with it. Restoring that value recovered the service without reinitializing the vault.

The desktop integration also depended on a PATH shim that Omarchy's packaged dispatcher and Hyprland PATH ordering bypassed. User-owned adapters now cover the unified command, direct launcher, menu/default selection and desktop entry. The systemd service uses the installed Node 22 alias and the normal CLI boot entrypoint.

## Timeline

| Time                  | Observed event                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-11 23:35 CEST | Service startup refused: vault entry `minimax_api_key` could not be decrypted; exit 102.                                                     |
| 2026-10-11 23:41 CEST | System check found the failed user unit; disk and memory availability were healthy.                                                          |
| 2026-10-11 23:46 CEST | Private pre-change backup created. Matching backup pepper restored; vault check and service startup succeeded.                               |
| 2026-10-11–12         | Omarchy command/menu/PATH integration completed, service override validated, data paths pinned.                                              |
| 2026-10-12            | Real MiniMax generation returned HTTP 200 and `MEMPHIS_OK`. Missing DID initialized without rotation; doctor required failures reached zero. |
| 2026-10-12 12:22 CEST | Private repaired recovery set and additional standard archive created. SQLite snapshots and copied vault entries verified.                   |

These are observed timestamps, not a claim of continuous downtime between the first failure and the end of documentation work.

## Root cause

The persisted environment and encrypted vault state were inconsistent. Current pepper failed AES-GCM authentication; two env backups succeeded against the same files. There was no need to replace the master key or entry ciphertext. The specific writer that changed the pepper was not established.

A separate integration defect left Memphis outside the packaged default-agent whitelist. The existing shim was behind `/usr/share/omarchy/bin` in the desktop environment. Even a correctly ordered `omarchy-agent` shim alone would not intercept the unified CLI's absolute dispatch. The menu's Memphis row also invoked the packaged default selector, which rejected Memphis.

## Evidence

- Journal: `memphis.service` exit 102 and vault integrity refusal.
- Direct authenticated decryption: current env failed; the two preserved env backups succeeded; entry fingerprint verification passed.
- Native and TS vault reads succeeded after restoring the matching pepper.
- Installed Omarchy dispatcher and Hyprland environment source confirmed absolute dispatch and PATH precedence.
- Supported DID initialization reported `rotated=false` and stored its seed encrypted.
- Full executed checks are recorded in [VALIDATION](../plans/2026-10-12-memphis-refactor/VALIDATION.md).

No plaintext credential or raw environment is included in this postmortem.

## Resolution

Restored only the matching pepper and retained the vault files. Cleared unconfigured optional Telegram/DeepSeek/GLM references. Pinned database, audit, queue and vault paths. Added user-owned launcher adapters, fixed menu routing, set PATH precedence for shell/UWSM/Hyprland, and validated the desktop configuration. Kept service restart rate limits and integrity-related exit protections; added a local override for stable Node selection and private umask.

Initialized the absent DID using the existing CLI. Created a private complete credential/database recovery supplement and a separate standard archive. The existing daily backup job was already enabled, so no duplicate schedule was added.

## Lessons learned

Running-process caches can conceal broken persistent credentials until reboot. General config setters must not treat pepper rotation as an ordinary env write. Diagnostic success must identify whether it means local decryption or an actual provider response. User desktop integrations must test command dispatch, menu and session PATH, not only one keyboard binding.

A standard backup can pass its checksum while omitting data essential to host recovery. Recovery coverage and isolated restore evidence must be explicit.

## Open questions

- Which operation changed the pepper, and was the previous in-memory state masking it?
- What records remain only in the older home-relative database?
- Which component accounts for the operator-reported 105k-token input?
- Which historical credential-like documentation values were ever active? Redaction alone cannot answer exposure or rotation questions.

## TL;DR for future sessions

Use the configured absolute paths. Do not reset vault or disable its probe for this failure class. Verify candidate env/state pairs privately. The repaired recovery set is identified in [OPERATIONS](../plans/2026-10-12-memphis-refactor/OPERATIONS.md); the pre-change env is not a known-good restore target.

## Follow-ups

Execute [S1–S9](../plans/2026-10-12-memphis-refactor/SPRINTS.md), with priority on transactional credentials, policy parity and complete recovery. Track implementation evidence separately from this completed local repair.

## Anti-confab

Verified: local repair, real MiniMax request, native TUI preflight and one interactive PTY cycle, service restart, zero required doctor failures, archive verification, copied SQLite integrity and copied vault decryption.

Not verified: full host reboot, fresh installation, complete restored-host startup, all pending source changes, long-term availability, historical credential exposure, or product-wide completion of the refactor. Fourteen doctor warnings remained; AUDIT distinguishes optional features from known diagnostic inconsistencies.
