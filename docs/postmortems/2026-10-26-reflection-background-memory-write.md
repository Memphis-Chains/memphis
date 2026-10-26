# Reflection completion preceded its memory-chain write

The ARM suite on PR #692 passed every assertion but failed during fixture
cleanup with `ENOTEMPTY` in `tests/unit/reflection-loop.test.ts`.

`runReflectionCycle` awaited reflection/insight persistence, then called the
synchronous `writeMemoryAction`. That function appended to `soul` in the
background and omitted its supplied environment. The cycle could return while
that append was still writing. Teardown restored environment variables and
removed the fixture before the writer completed.

The observed failure was a nonempty temporary directory. This run does not
establish that operator chains were modified. Late writers combined with
mutable environment resolution are the same risk class as the earlier test
isolation incident; a cleanup retry alone would leave that risk in place.

The cycle now awaits the memory-action chain write. A captured environment
anchors its model stores, derived search index, soul memory and local memory
action file. Default `ChainStore` callers retain their previous environment
behavior. Captured environments are private fields, not serialized properties.
The synchronous memory-action API remains compatible for existing callers.

A deterministic delayed-writer test fails on the previous implementation and
passes with the fix. It verifies that the cycle remains pending, waits for
release, and preserves the supplied destination even when the caller mutates
its environment object. Existing reflection, soul-memory, model and durable
write suites also pass. CI must repeat the complete suite on the final head.

See `docs/postmortems/2026-10-15-vault-test-isolation.md`.
