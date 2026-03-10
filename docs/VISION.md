# Memphis v4 Vision

**"OpenClaw executes. Memphis remembers."**

---

## 🎯 What Memphis Is

Memphis is a **local-first cognitive memory layer** for AI systems — primarily designed to give OpenClaw persistent memory, encrypted storage, and multi-agent synchronization.

### Core Role

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

**OpenClaw** = "Hands" (execution, tools, agents)
**Memphis** = "Brain" (memory, decisions, learning)

---

## 🧠 Key Capabilities

### 1. Persistent Memory (Chains)
- **Immutable storage** — Every memory is cryptographically linked
- **Never forgets** — All context survives restarts
- **Blockchain-like integrity** — SHA256 chain verification

### 2. Semantic Search (Embeddings)
- **Find anything** — Query by meaning, not keywords
- **Context injection** — Give LLMs your full history
- **Ollama-powered** — Local embeddings (nomic-embed-text)

### 3. Encrypted Vault (Secrets)
- **Military-grade crypto** — Argon2id + AES-256-GCM
- **Zero-knowledge** — Even LLM can't see secrets without passphrase
- **2FA support** — Additional security layer

### 4. Cognitive Models (Decisions)
- **Track all choices** — Never lose decision history
- **Pattern recognition** — Learn from past decisions
- **Predictive insights** — Anticipate future needs

### 5. Multi-Agent Sync (Federation)
- **Share knowledge** — Sync across OpenClaw instances
- **Collaborative decisions** — Multi-node consensus
- **Campfire Circle Protocol** — Decentralized coordination

---

## 🎯 Primary Use Case: OpenClaw Integration

### Problem OpenClaw Has
- ❌ No persistent memory (session-based only)
- ❌ No semantic search (can't find past context)
- ❌ No decision tracking (forgets choices)
- ❌ No encrypted storage (secrets in plaintext)
- ❌ No multi-agent sync (isolated instances)

### Memphis Solves This
- ✅ Persistent memory (chains)
- ✅ Semantic search (embeddings)
- ✅ Decision tracking (audit trail)
- ✅ Encrypted vault (Argon2id + AES-256-GCM)
- ✅ Multi-agent sync (federation)

---

## 🔧 Integration Methods

### Option 1: HTTP API
```bash
# Memphis runs as API server
memphis server start --port 3001

# OpenClaw calls via HTTP
POST http://localhost:3001/api/journal
{
  "text": "User prefers TypeScript over Python",
  "tags": ["preference", "language"]
}
```

### Option 2: MCP Server (Model Context Protocol)
```bash
# Memphis as MCP server
memphis mcp serve --port 3002

# OpenClaw connects via MCP
# Tools: memphis_journal, memphis_recall, memphis_decide
```

### Option 3: Direct Integration (shared code)
```typescript
import { MemphisClient } from '@memphis/chains';

const memphis = new MemphisClient({
  dataPath: '/home/user/.memphis',
  encryption: true
});

await memphis.journal("User chose React for frontend");
```

---

## 💡 Standalone Capability

While Memphis is designed as OpenClaw's memory layer, it **works independently**:

### Personal AI Guardian
- **Your AI companion** — Trust with secrets, it never reveals
- **Financial assistant** — Secure banking + crypto (with guardrails)
- **Family connector** — Encrypted P2P messaging
- **Automation engine** — Run pipelines autonomously

### Key Features (Standalone)
- Local-first (no cloud dependency)
- Encrypted vault (secrets safe)
- Immutable memory (never forgets)
- Multi-provider LLM (freedom of choice)

---

## 🚀 Roadmap

### Phase 1: Memory Layer (Current)
- ✅ Rust core (chain, vault, embed)
- ✅ Multi-provider LLM
- ✅ CLI/TUI interface
- 🔄 HTTP API server
- 🔄 MCP server

### Phase 2: OpenClaw Integration
- 🔄 OpenClaw plugin (memphis-memory-provider)
- 🔄 Cognitive models (5 models from v3)
- 🔄 Context injection for LLM
- 🔄 Performance optimization

### Phase 3: Federation
- 🔄 Multi-agent sync protocol
- 🔄 Collaborative decisions
- 🔄 Knowledge sharing
- 🔄 Decentralized network

### Phase 4: Extended Features
- 🔄 Banking/crypto integration
- 🔄 P2P messaging
- 🔄 Pipeline automation
- 🔄 Mobile companion

---

## 🎯 Design Principles

### 1. Local-First Sovereignty
- **Your data stays on your machine**
- No cloud dependency
- Privacy by design

### 2. Cryptographic Integrity
- **SHA256 chains** — Immutable memory
- **AES-256-GCM vault** — Military-grade encryption
- **Argon2id** — Password hardening

### 3. Zero-Knowledge Architecture
- **Even LLM can't see secrets** without passphrase
- Context injection (LLM sees only what's needed)
- Encrypted at rest and in transit

### 4. Modular Architecture
- **Rust core** (performance + security)
- **TypeScript shell** (flexibility + ergonomics)
- **NAPI bridge** (seamless FFI)

### 5. Multi-Provider Freedom
- **Not locked into OpenAI/Anthropic**
- Ollama for local inference
- Cohere, Google, custom providers

---

## 🏗️ Technical Stack

```
┌─────────────────────────────────────┐
│     USER INTERFACES                  │
│  CLI │ TUI │ HTTP API │ MCP         │
├─────────────────────────────────────┤
│   AGENT RUNTIME (TypeScript)         │
│  Orchestration │ Skills │ Memory    │
├─────────────────────────────────────┤
│     MULTI-PROVIDER LLM               │
│  OpenAI │ Anthropic │ Ollama │ ...  │
├─────────────────────────────────────┤
│      NAPI-RS BRIDGE                  │
│  Rust ↔ TypeScript FFI              │
├─────────────────────────────────────┤
│      RUST CORE (Sovereign)           │
│  Chain │ Vault │ Embed │ DID        │
│  Argon2id │ AES-256-GCM │ Ed25519   │
└─────────────────────────────────────┘
```

---

## 🎯 Target Users

### 1. OpenClaw Users (Primary)
- Want persistent memory for their AI assistant
- Need encrypted storage for secrets
- Want multi-agent synchronization
- Need decision tracking

### 2. Privacy Advocates (Secondary)
- Want local-first AI
- Don't trust cloud providers
- Need cryptographic guarantees
- Value data sovereignty

### 3. Developers (Tertiary)
- Building AI applications
- Need memory layer for their agents
- Want open-source solution
- Require extensible architecture

---

## 📊 Success Metrics

### For OpenClaw Integration
- Memory recall latency < 100ms
- Zero data loss (chain integrity 100%)
- Seamless context injection
- Multi-agent sync < 5s propagation

### For Standalone Use
- Easy install (< 5 minutes)
- Works offline (100%)
- Encrypted vault (zero-knowledge)
- Multi-provider support

---

## 🎯 Non-Goals

**Memphis is NOT:**
- ❌ Replacement for OpenClaw (complementary, not competitive)
- ❌ General-purpose database (specialized for AI memory)
- ❌ Cloud service (local-first by design)
- ❌ Consumer app (developer/technical focus)

**Memphis IS:**
- ✅ Memory layer for AI systems
- ✅ Local-first sovereign storage
- ✅ OpenClaw's persistent brain
- ✅ Standalone personal AI (optional)

---

## 📚 References

- **Oryginalny Memphis v3**: https://github.com/elathoxu-crypto/memphis
- **OpenClaw**: https://github.com/openclaw/openclaw
- **Blueprint**: `/docs/BLUEPRINT-GAP-ANALYSIS.md`
- **Architecture**: `/docs/ARCHITECTURE-MAP.md`

---

## 🎯 TL;DR

**Memphis v4 = Local-first cognitive memory layer for OpenClaw**

- **Primary role**: Give OpenClaw persistent memory + encrypted storage
- **Secondary role**: Standalone personal AI guardian
- **Key features**: Chains, vault, embeddings, federation
- **Philosophy**: Local-first, sovereign, zero-knowledge

**Tagline:** "OpenClaw executes. Memphis remembers."

---

Created: 2026-03-10
Version: 1.0
Status: Approved by Elathoxu
