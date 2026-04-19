# memphis-case-index

Indexed lookup over the `cases` chain. Backs the `memphis_case_query` MCP tool.

## Public surface

- Index a case block by actor / target / case-type / timestamp
- Query by composite filter (e.g. all "DECISION" blocks involving actor X)
- Rebuild index from canonical chain blocks
- Verify index hash matches chain truth

## Build

```bash
cargo build -p memphis-case-index
cargo test -p memphis-case-index --lib
```

13 tests passing as of v1.3.0 (case-block validation, query composition, hash verification).

## Layer

L1 storage adjunct — pure derivative of the canonical `cases` chain. Index can always be rebuilt from chain truth via `rebuild_from_blocks`.

## Status

Skeleton (single `lib.rs`). Will grow as Memphis's case-based reasoning capabilities expand. The case-block schema (8 grammatical cases — nominative, genitive, dative, accusative, instrumental, locative, vocative, ablative) is the core abstraction.
