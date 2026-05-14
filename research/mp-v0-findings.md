# MP v0 — badanie integracji (2026-05-13)

## Co jest

### Podpisywanie i weryfikacja
- **`src/federation/mp/envelope.ts`** — rdzeń kryptograficzny
  - Podpisywanie `SyncEnvelope` via `node:crypto` Ed25519
  - Weryfikacja podpisów (discriminated union `VerifyEnvelopeResult`, nigdy nie rzuca wyjątków)
  - Format DID: `did:memphis:z<base58btc(0xed01 || pubkey32)>` — multibase58btc, nie `did:key`
  - Canonicalizacja JSON (sortowane klucze, deterministyczna)
  - Implementacja base58-btc w czystym TS (bez zewnętrznych libek)

### Klucz signingowy
- **`src/federation/mp/operator-key.ts`**
  - Osobny keypair od głównego vault DID (bo Rust nie eksponuje seed'a do TS)
  - Przechowywany w vault pod `mp_v0_signing_seed` (base64-encoded)
  - Leniwe generowanie — jeśli seed nie istnieje, tworzy nowy i zapisuje

### Eksporty
- **`src/federation/index.ts`** — barrel export całości

### Abstrakcja transportowa
- **`src/sync/transport.ts`** — interfejs transportowy:
  - `connect()`, `send(envelope)`, `onMessage(handler)`, `close()`
  - WebSocket (P2P bezpośredni) i Matrix (federacyjny pokojowy) były planowane

## Czego NIE ma

| Komponent | Status |
|---|---|
| WebSocket transport | interfejs — brak implementacji |
| Matrix transport | usunięty (Karpathy refactor) |
| IPFS integration | plik istnieje — nie badany |
| `messages` chain | istnieje w łańcuchach — brak wpisów w `~/.memphis/chains/messages` |
| Agent registry | plik istnieje — nie badany |

## Most do Claude Code / OpenClau

**`src/bridges/mcp-native-gateway.ts`** — MCP JSON-RPC handler:
- Metoda `memphis.ask` (input string → output string)
- Może być wystawiona jako MCP server

## Rekomendacja integracji

```
Claude Code → MCP client → Memphis (memphis.ask)
Claude Code → HTTP POST  → Memphis HTTP gateway (jeśli wystawiony)
OpenClau  → vault file → ~/.memphis/shared/inbox.json (najprostsze dziś)
```

MP v0 jest gotowy na poziomie podpisów, ale warstwa transportowa (WebSocket/Matrix) nie jest jeszcze uruchomiona — realnie najszybciej przez MCP gateway lub shared files.