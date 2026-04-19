# Performance Tuning Guide

Use this guide to improve throughput and latency in Memphis deployments.

## 1) Runtime basics

- Use Node.js 20+ (LTS) for stable runtime performance.
- Keep Rust bridge enabled in production: `RUST_CHAIN_ENABLED=true`.
- Prefer SSD for `MEMPHIS_DATA_DIR`.

## 2) Provider strategy

- Use `provider=auto` for resilience.
- Use `strategy=latency-aware` for lower tail latency when multiple providers are configured.
- Monitor `/v1/providers/health` and `/v1/ops/status` to spot slow/down providers.

## 3) Request sizing

- Keep `/v1/chat/generate` input concise (soft cap is 20k chars).
- Chunk large workflows into smaller prompts.
- Reuse session/context identifiers where possible.

## 4) Caching and embeddings

- Keep embed/query cache enabled for repeated recall workloads.
- Tune cache TTL via `EMBED_CACHE_TTL_SECONDS`.
- Batch embed operations instead of one-item loops.

## 5) Backup I/O impact

- Schedule `memphis backup create` during lower traffic windows.
- Run retention cleanup regularly:
  - `memphis backup clean --keep 7`
- Verify backups after creation when in strict environments:
  - `memphis backup verify <id-or-file>`

## 6) Observe and tune

- Check liveness and ops:
  - `memphis health`
  - `curl -s http://127.0.0.1:3000/v1/ops/status`
- Use debug profiling for bottlenecks:
  - `memphis debug profile "<command>" --format json`
- Track p95 latency and memory growth over time.

## 7) Practical baseline checklist

- [ ] Node.js 20+
- [ ] SSD-backed data dir
- [ ] Provider health monitored
- [ ] Backup retention configured
- [ ] p95 latency trend reviewed weekly
