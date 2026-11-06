# Semantic memory repair — 2026-11-06

A persisted semantic index had 32-dimensional vectors while the configured
Ollama model used 768 dimensions. It contained only eight documents. A synthetic
two-process reproduction also showed that independent daemon and native TUI
writers could both report success while the second writer discarded the first
writer's additions.

The candidate repair serializes index read/merge/write with a stable OS lock,
tracks pending changes, refuses corrupt or wrong-dimensional storage, and makes
readers refresh after other processes publish. Rebuilds require the bridge's
non-destructive clear and abort functions; a failed or interrupted replacement
must not publish partial contents. Rebuild IDs use chain coordinates because
custom memory IDs can collide. A chain-scoped rebuild does not clear the other
chains. Health checks inspect a canonical v1 dimension header without parsing
the full index; that header check is not an integrity verification.

The local migration candidate was built separately from canonical chains using
Ollama BGE-M3, 1024 dimensions. A pinned local model alias
`memphis-memory-bge:20261105` points to digest
`sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`.
The staged copy contained 12,894 chunks from 9,460 source blocks after catch-up;
validation found no duplicate IDs or malformed vectors. Canonical chains remain
the source of truth. The previous 32-dimensional index is preserved.

On a small synthetic set of ten Polish query/document pairs, BGE-M3 ranked the
matching document first in 10 cases; the installed Nomic model with its
recommended task prefixes did so in 2. This is a smoke test, not a benchmark
of real-world accuracy. One synthetic Basal-1.5-mini candidate-selection test
was incorrect and took 28 seconds. Basal therefore remains advisory and is not
inserted into every recall. Memphis Kartograf has no installed signed checkpoint
here, and its 256-dimensional space is not wired into this index.

The runtime index must stay private. If configured outside the Memphis data
directory, it is not included automatically in the standard data-directory
backup; the chains are backed up and can regenerate it. Keep a protected copy
of the migration artifact and verify the configured model and index together.
Dimension checks do not prove that two models with equal dimensions share a
vector space; full model/tokenizer identity binding is still a future guard.

See `docs/dev/KARTOGRAF-EMBEDDING-SPACE.md` and decision `decisions/000495`.
