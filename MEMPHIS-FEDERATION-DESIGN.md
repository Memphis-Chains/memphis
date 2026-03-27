# Memphis Federation Design — Warstwa Języka Agenta

> "Projekt za trylion dolarów" — 2026-03-27

---

## 3 Warstwy Architektury

```
┌─────────────────────────────────────────────────────┐
│  Memphis Language (ML)                              │
│  DSL dla ludzi + agentów                           │
│  Konfiguracja, intencje, protokół negocjacji       │
├─────────────────────────────────────────────────────┤
│  Memphis Protocol (MP)                              │
│  Serializacja, transport, signing, timestamping     │
│  JSON-like, signed, auditable                       │
├─────────────────────────────────────────────────────┤
│  Rust Core + Chains                                 │
│  Immutable audit trail, vault, memory               │
│  SHA-256 chains, execution engine                   │
└─────────────────────────────────────────────────────┘
```

---

## Layer 1: Memphis Language (ML)

**Cel:** Język który rozumieją ludzie I agenci. Konfiguracja + komunikacja agent↔agent.

### Filozofia
- Agent-potocz-agent to NIE tylko transfer danych (JSON)
- To INTENCJE + KONTEKST + RELACJE ZAUFANIA + NEGOCJACJE
- RAG jest stateless (retrieve). Federacja jest STATEFUL — pamięta kto pytał, co obiecał, deadline

### Przykład ML (S-expression style):

```
(request
  :from marcin
  :to synjar
  :action search
  :query "dokumenty projektu X"
  :deadline 2026-03-28
  :trust-level high
  :scope [documents, metadata]
  :confidential true
)
```

### Konfiguracja agenta w ML:

```
AGENT marcin {
  TRUST: high
  SCOPE: [files, calendar, messages, sqlite]
  MODEL: minimax-m2
  VAULT: encrypted
}

AGENT synjar {
  TRUST: medium
  SCOPE: [knowledge_base, documents]
  MODEL: openai-gpt-4
  DIALECT: ml-v1
  TRANSLATOR: true
}
```

---

## Layer 2: Memphis Protocol (MP)

**Cel:** Serializacja ML do postaci przesyłanej między agentami. Signed, timestamped, auditable.

### Właściwości
- JSON-like (łatwy to parse)
- Signed (nikt nie podrobi)
- Timestamped (kolejność ważna)
- Auditable (full chain history)
- Forward-only (nie można zmienić przeszłości)

### Przykład MP:

```json
{
  "id": "msg-2026-03-27-001",
  "type": "request",
  "from": "agent:memphis/marcin",
  "to": "agent:synjar",
  "action": "search",
  "payload": {
    "query": "dokumenty projektu X",
    "scope": ["documents", "metadata"]
  },
  "meta": {
    "deadline": "2026-03-28T00:00:00Z",
    "trust_level": "high",
    "confidential": true
  },
  "signature": "base64-sha256-...",
  "timestamp": "2026-03-27T20:30:00Z"
}
```

---

## Layer 3: Rust Core + Chains

**Cel:** Izolacja, bezpieczeństwo, immutable audit trail.

### Odpowiedzialności
- Execution engine (uruchamia agenty)
- Vault (tajemnice, szyfrowanie)
- Memory chains (journal, reflections, decisions)
- SHA-256 immutable append-only chains
- Trust verification

### Co Rust Core NIE robi:
- Nie zna ML (to layer above)
- Nie wie że jest częścią federacji (to layer above)
- Po prostu executuje i loguje

---

## Federacja Agenta-Agenta

### Problem
Agent A (Memphis) chce zadzwonić do Agenta B (Synjar, Hermes, cokolwiek).
Obaj muszą siędogadać.

### Rozwiązanie: Dialect System

```
FOREIGN_AGENT synjar {
  DIALECT: ml-v1
  TRANSPORT: matrix
  ENDPOINT: localhost:3777
  TRANSLATOR: true   ← potrafi tłumaczyć na ml-v1
}

FOREIGN_AGENT hermes {
  DIALECT: hermes-protocol-v2
  TRANSPORT: http
  ENDPOINT: https://hermes.example.com
  TRANSLATOR: true
}
```

### Negocjacja zdolności

```
(hello
  :agent marcin
  :protocols [ml-v1, mp-v1]
  :capabilities [search, recall, execute]
  :trust-requirements [signed-messages, timestamp-verification]
)

(ack
  :agent synjar
  :agreed-protocol ml-v1
  :capabilities [search, knowledge-base]
  :trust-verified true
)
```

---

## Dlaczego nie Vector Search / RAG jako federacja?

| Aspekt | Vector Search / RAG | Memphis Language |
|--------|---------------------|------------------|
| Stan | Stateless | Stateful |
| Relacja zaufania | Brak | Wbudowana |
| Negocjacja | Brak | Pełna |
| Interpretacja intencji | Słaba | Silna |
| Audit trail | Opcjonalny | Wymagany |

---

## Kolejne kroki

1. **Spisać gramarykę ML** (ANTLR albo nom)
2. **Zdefiniować MP v1** (prototyp w JSON)
3. **Zaimplementować translator** (Memphis ↔ Synjar jako pilot)
4. **Dodać do Rust Core** (może być external crate)

---

## Powiązane plany

- `.openclaw/workspace/SELF-EVOLVING-DESIGN.md` — self-evolution agenta
- `.openclaw/workspace/MEMPHIS-ARCHITECTURE-v1.md` — pełna architektura
- `.openclaw/workspace/SPRINT_STATUS.md` — sprinty i milestone
