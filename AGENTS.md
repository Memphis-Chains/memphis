# Workspace Agent Guide

This file contains Memphis-managed workspace context for agent tools.

<!-- memphis:context:start -->
## Memphis Workspace Context

- workspace: `memphis`
- purpose: Shared MemphisOS workspace for supervised, auditable agent work.
- notes dir: `notes/`
- memory dir: `memory/`
- apps dir: `apps/`
- preferred formats: `markdown, json`

## Working Rules
- Prefer local-first, auditable, and reversible changes.
- Treat secrets as vault-managed values, not committed files.
- Keep human-facing plans and notes in Markdown.
- Use MemphisOS as the control plane; keep vendor-specific integrations downstream.
<!-- memphis:context:end -->

## Local Notes

Add tool-specific notes below this line. Memphis only manages the block above.
