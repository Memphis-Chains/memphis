# Vision Refactor — 2026-03-10

## 🎯 What Changed

**Previous vision:** Memphis as standalone "Sovereign AI Agent Platform"
**New vision:** Memphis as **OpenClaw's Memory Layer** + standalone capability

---

## 💡 Why the Pivot

### Original Intent (Rediscovered)
User created Memphis (v3) specifically to **enhance OpenClaw's memory**:
- "zacząłem robić memphis, żeby usprawnić pamięć openclaw"
- Original repo: github.com/elathoxu-crypto/memphis
- Goal: Give OpenClaw persistent memory, semantic search, encrypted storage

### The Realization
After exploring "Sovereign AI Agent Platform" direction, user pointed out:
- "widze ze bardzo nie chcesz zeby memphis zastapil openclaw"
- **Key insight:** Memphis was NEVER meant to replace OpenClaw
- Memphis + OpenClaw = **synergy**, not competition

---

## 🏗️ New Architecture

```
┌─────────────────────────────────────┐
│        OpenClaw Gateway              │
│  - Multi-agent orchestration         │
│  - Tool execution                    │
│  - External integrations             │
└─────────────┬───────────────────────┘
              │ Memory API
┌─────────────▼───────────────────────┐
│      Memphis (Memory Layer)          │
│  - Persistent chains (immutable)     │
│  - Semantic search (embeddings)      │
│  - Encrypted vault (secrets)         │
│  - Cognitive models (decisions)      │
│  - Multi-agent sync (federation)     │
└─────────────────────────────────────┘
```

**OpenClaw** = "Hands" (execution)
**Memphis** = "Brain" (memory)

---

## 📊 What Memphis Provides OpenClaw

### Problems Solved
- ❌ OpenClaw has no persistent memory (session-based only)
- ❌ No semantic search (can't find past context)
- ❌ No decision tracking (forgets choices)
- ❌ No encrypted storage (secrets in plaintext)
- ❌ No multi-agent sync (isolated instances)

### Memphis Solutions
- ✅ Persistent memory (immutable chains)
- ✅ Semantic search (embeddings)
- ✅ Decision tracking (audit trail)
- ✅ Encrypted vault (Argon2id + AES-256-GCM)
- ✅ Multi-agent sync (federation)

---

## 🔧 Integration Methods

### 1. HTTP API
```bash
memphis server start --port 3001
POST /api/journal → Store memory
GET  /api/recall → Search memories
```

### 2. MCP Server
```bash
memphis mcp serve --port 3002
Tools: memphis_journal, memphis_recall, memphis_decide
```

### 3. OpenClaw Plugin
```typescript
import { MemphisMemoryProvider } from '@memphis/openclaw-plugin';
// Seamless integration with OpenClaw memory interface
```

---

## 🚀 New Roadmap (V5)

### Phase 1: Memory Layer (Weeks 1-2)
- HTTP API server (Fastify)
- MCP server implementation
- OpenClaw plugin scaffold

### Phase 2: Cognitive Engine (Weeks 3-4)
- Port 5 cognitive models from v3
- Context injection for LLM
- Performance optimization

### Phase 3: Federation (Weeks 5-6)
- Multi-agent sync protocol
- Collaborative decisions
- Knowledge sharing

---

## 💡 Standalone Capability

While primary role is OpenClaw integration, Memphis **works independently**:

### Personal AI Guardian
- Local-first (no cloud)
- Encrypted vault (secrets safe)
- Immutable memory (never forgets)
- Multi-provider LLM (freedom)

### Use Cases
- Personal knowledge base
- Family AI assistant
- Secure financial assistant
- Automation engine

---

## 🎯 Design Principles (Unchanged)

1. **Local-First Sovereignty** — Your data stays on your machine
2. **Cryptographic Integrity** — SHA256 chains, AES-256-GCM vault
3. **Zero-Knowledge Architecture** — Even LLM can't see secrets without passphrase
4. **Modular Architecture** — Rust core + TypeScript shell
5. **Multi-Provider Freedom** — Not locked into OpenAI/Anthropic

---

## 📚 References

- **Original Memphis v3:** https://github.com/elathoxu-crypto/memphis
- **New Vision Doc:** `/docs/VISION.md`
- **Updated Roadmap:** `ROADMAP-MASTER-QUEUE.md` (V5 milestones)
- **Decision Record:** `MEMORY.md` (Decision #79)

---

## 🎯 Tagline

**"OpenClaw executes. Memphis remembers."**

---

Created: 2026-03-10 22:20 CET
Author: Memphis (on behalf of Elathoxu)
Status: APPROVED ✅
