# Telegram interactive turns

Telegram polling must remain available while a text turn is working. A text
turn runs in the background, with one active turn per chat and per resolved
actor. A new text arriving for that chat or actor is explicitly refused with a
request to resend after the active turn; it is not silently queued. Status,
model and tools probes can answer while a turn is active, as can the existing
privilege-revocation and authorized restart commands. A turn already running
retains its per-turn permission snapshot. In-flight work is
not durable across a process restart, and Telegram's existing startup policy
for pending updates is unchanged.

For Telegram the gateway caps a turn at 16 tool calls, gives each provider
request at most 120 seconds and stops starting new agent-loop work after four
minutes. A tool that is already running is allowed to finish, so this is not a
hard deadline on its side effects. When work stops at a limit, the reply says
that some actions may have already happened and does not claim completion.
Other surfaces keep their existing limits.

Telegram `memphis_exec` uses a nonblocking subprocess while retaining the
existing policy, audit and per-surface/per-actor failure budget. Concurrent
exec requests for the same identity are serialized before checking the
budget. Other synchronous tools can still delay the Node event loop, so this
change does not guarantee responsiveness during every possible tool.

Basal prompt classification remains enabled or disabled according to its
existing configuration; it still runs before generation and can add latency.
This change does not switch the Basal model or assert a token-cost saving.

Restore uses renames between its temporary directory and data root. If those
are on different filesystems, it now refuses before creating a pre-restore
backup or moving data. This is a safety check, not cross-filesystem restore
support. Follow the restore runbook with a private temporary directory on the
same filesystem; cross-host credentials and runtime database recovery require
separate verification.
