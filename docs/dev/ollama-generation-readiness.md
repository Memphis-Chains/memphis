# Verify offline generation readiness

An Ollama daemon can serve only embedding models, or reject unauthenticated
requests with 401. Neither condition proves that the configured chat model can
generate. The previous health probe accepted every HTTP status below 500.

The metadata probe now requires a successful model list, the configured
`OLLAMA_MODEL` (default matching the provider), and a `completion` capability
from `/api/show`. It never downloads or loads a model. Each request has a 400 ms
timeout, redirects are refused, and unverified capabilities fail closed.

`offline.ollamaGeneration` exposes the reason and configured model.
`offline.localFallbackKind = echo` identifies the deterministic in-process
fallback. `offline.ready` retains local-fallback availability for compatibility;
consumers requiring actual inference must inspect `ollamaGeneration.canGenerate`
or the health of their remote provider. A metadata check is not a performance
benchmark, does not prove free RAM, and does not test provider failover.

The added fields are optional on historical snapshot types. An older Ollama
server without capability metadata is reported unverified instead of assumed
capable. Unit tests mock all requests and contain no operator data.
