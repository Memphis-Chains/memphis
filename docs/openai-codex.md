# OpenAI through the local Codex account

Memphis supports `openai` using a locally installed, authenticated Codex app-server.
Codex owns ChatGPT login and token refresh. Memphis does not copy OAuth tokens into
its vault and this adapter does not fall back to an OpenAI API key.

Run `codex login` under the same OS account that runs Memphis. Enable
`OPENAI_AUTH_MODE=codex` in the runtime `.env` and restart the Memphis service.
In the native TUI, select:

```text
/provider openai
/model gpt-5.6-sol-max
```

The `gpt-5.6-sol-max` preset selects the official `gpt-5.6-sol` model with
reasoning effort `max`. Memphis also accepts the display-like spelling
`gpt-5.6-Sol Max`, but the hyphenated preset is recommended for `.env` and TUI
commands. Selecting plain `gpt-5.6-sol` leaves reasoning effort at the model or
account default.

The requested `astra-gtp6-max` spelling is supported. It selects `gpt-6-astra`
with reasoning effort `max`; `astra-gpt6-max` and `gpt-6-astra-max` are equivalent
aliases. The TUI retains the preset across replies. `OPENAI_MODEL` sets the default
preset, `CODEX_BIN` can point to a Codex executable, and
`OPENAI_CODEX_TIMEOUT_MS` sets the per-request timeout (default 180000 ms).
`DEFAULT_PROVIDER=openai` also enables the runtime provider. Choosing a provider
in TUI persists that default for later starts; `/model` persists `OPENAI_MODEL`.

Provider status checks local prerequisites. Model listings contain supported
presets, not proof of account access or remaining credits. A completed real turn
verifies account/model access at that moment. Account failures are reported by
this adapter; no API-key billing fallback is implemented.

## Account limits versus model limits

The context window in the API documentation (1,050,000 for both `gpt-5.6-sol`
and `gpt-6-astra`) is the model's ceiling, not what a given account is granted.
An account is typically granted less, and the Codex model catalog on disk
records that grant together with the share of it the model may use (`context_window` and
`effective_context_window_percent`, e.g. 272000 × 95% = 258400).

Memphis reads that local catalog, so the effective limit is known before the
first request of a conversation rather than only after a completed turn. The
server also reports the same value with each turn as `modelContextWindow`;
whichever source is available is used, and history is trimmed to the smaller of
the model ceiling and the account grant. An account may only narrow the window,
never widen it, so a provider cannot hide real context pressure by
over-reporting. The value is persisted per conversation and shown in the native
TUI status bar.

## Credit exhaustion is reported precisely

Codex streams account rate limits as `account/rateLimits/updated`, including
`credits.hasCredits` and `rateLimitReachedType`. When workspace credits are
exhausted the adapter fails with `CODEX_NO_CREDITS` and an operator-facing
message instead of a generic turn failure. A closed rolling usage window with
credits still present stays `CODEX_TURN_FAILED` — the two are different
conditions with different remedies.

The TypeScript provider and Rust TUI share the same app-server client. Each
request uses an ephemeral thread with the supplied Memphis conversation and tool
results. A dynamic tool call returns to the existing Memphis tool loop for
policy checks and execution; its result is included in the next request. Codex
host execution tools, plugins and configured MCP servers are disabled in the
child. The child receives a restricted transport environment, excluding Memphis
provider keys, API tokens and the vault pepper. Prompts travel through stdin.
Timeouts, cancellation, invalid frames and failed turns stop the child and return
fixed public errors. Partial text from a failed turn is not accepted as success.
The current adapter supports text and Memphis tool calls; image input is not
implemented. Native TUI requires both its Rust binary and the compiled TypeScript
bridge under `dist/providers/openai-codex/`.

Protocol and authentication reference:
[OpenAI Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
Model reference:
[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).
