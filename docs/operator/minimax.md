# MiniMax M3.1 Flash

Memphis defaults to `MiniMax-M3.1-Flash` when MiniMax is selected without an
explicit model. Existing `MINIMAX_MODEL` pins remain authoritative. The model
picker lists the current Flash and M3 models plus the configured model, including
a custom or legacy ID. Availability of an explicit legacy pin depends on the
provider account. MiniMax announced Flash on [19 October 2026](https://www.minimax.io/blog/minimax-m31f).

## Configuration

Keep credentials in the existing vault. A routine interactive profile is:

```dotenv
DEFAULT_PROVIDER=minimax
MINIMAX_VAULT_KEY=minimax_api_key
MINIMAX_MODEL=MiniMax-M3.1-Flash
MINIMAX_REASONING_EFFORT=medium
GEN_MAX_TOKENS=32768
```

`medium` is a Memphis tradeoff for routine work, not a benchmark-proven optimum.
Choose `low` for simple tasks or `high`, `xhigh`, or `max` for difficult work.
The provider defaults to `max` when no effort is sent; Memphis sends its selected
level explicitly. `none` and disabled thinking are invalid. Changing effort is a
warm configuration change: recreate the provider or restart the runtime before
expecting it to apply. Per-call `reasoningEffort` takes precedence over provider
configuration. [Protocol reference](https://platform.minimax.io/docs/api-reference/text-openai-api).

The TypeScript MiniMax adapter uses its own `MINIMAX_REQUEST_TIMEOUT_MS` deadline
(default 30 minutes), not `GEN_TIMEOUT_MS`. For bounded interactive requests,
explicitly choose a deadline such as `90000`; allow more time for longer tasks.
The native interface also accepts this MiniMax-specific override; without it,
it retains its existing `GEN_TIMEOUT_MS` deadline.

`GEN_MAX_TOKENS` remains a combined reasoning-and-answer budget, not a target.
Small budgets can end with `finish_reason: length` before any answer appears.
The Flash adapter uses `max_completion_tokens`, preserves explicit caller limits,
and does not send ineffective temperature controls. Its direct-chat fallback is
32768 tokens; other providers retain their existing defaults. API capacity is
1M context and up to 524288 output tokens, distinct from a sensible session budget.
[Request limits](https://platform.minimax.io/docs/api-reference/text-chat-openai).

The native chat UI keeps its existing limit priority:
`MEMPHIS_GEN_MAX_TOKENS`, then `GEN_MAX_TOKENS`, then its 2048-token fallback.
Both adapters estimate the complete request, including continuation and tool
schemas, and reserve the completion limit within 92% of the context window.
An oversized protected conversation fails before sending a request; reasoning
and tool exchanges are not silently cut to fit. This remains an estimate, not
MiniMax's tokenizer.

## Tools and cost

Reasoning is optional continuation metadata. Memphis carries it through the
tool loop separately from the visible reply and returns it only to MiniMax on
the next call; it is not a user-facing answer. Preserve assistant tool-call IDs
and corresponding tool results when constructing a custom conversation.
[Tool conversation contract](https://platform.minimax.io/docs/guides/text-m3-function-call).

The default-model cost profile uses the published $0.15 input and $0.60 output
per million tokens, verified 24 October 2026. Cached input is $0.015 per million;
this is provider pricing, not a measured Memphis saving. Observe actual response
model, usage, cache reads and completed task quality when comparing efforts.
[Pricing](https://platform.minimax.io/docs/pricing/overview).

The TypeScript provider exposes the reported model and cache reads in
`ChatResponse`. Gateway model labels still describe the selected model, and its
standard token telemetry does not yet expose the cache breakdown.

Prompt caching is automatic for matching prefixes from 512 input tokens.
Keep tool definitions and stable instructions in a consistent order; avoid
inserting changing timestamps before reusable content. Cached prompt tokens are
already part of total prompt usage and must not be counted twice.
[Caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching).

Updating the provider configuration does not repair a failed memory-integrity
check. Diagnose that condition separately before restarting a stopped runtime;
do not bypass verification or edit chain blocks to make a model change take effect.
