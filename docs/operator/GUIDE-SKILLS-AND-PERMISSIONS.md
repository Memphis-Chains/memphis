# Instruktaż: Skille Agenta i Zezwolenia Self-Modyfikacji

# Guide: Agent Skills & Self-Modification Permissions

---

## Spis treści

1. [Dodawanie skilli (narzędzi MCP)](#1-dodawanie-skilli)
2. [Konfiguracja zezwoleń self-modyfikacji](#2-zezwolenia-self-modyfikacji)
3. [Trust rules — automatyczne zatwierdzanie](#3-trust-rules)
4. [Blocked paths i safety gates](#4-blocked-paths)

---

## 1. Dodawanie skilli

Skille Memphis = narzędzia MCP zarejestrowane w runtime. Każde narzędzie ma: nazwę, opis, tier bezpieczeństwa, schemat inputu i handler.

### Krok 1: Stwórz handler

```typescript
// src/mcp/tools/your-skill.ts
import type { ToolHandler } from './types.js';

export const yourSkillHandler: ToolHandler = async (params, context) => {
  const { input } = params;

  // Twoja logika
  const result = await doSomething(input);

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
};
```

### Krok 2: Zarejestruj w tool registry

```typescript
// src/gateway/tool-registry.ts
{
  name: 'memphis_your_skill',
  description: 'Opis co robi narzędzie',
  tier: 0,  // 0=free, 1=API token, 2=vault passphrase
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input parameter' },
    },
    required: ['input'],
  },
}
```

### Krok 3: Podłącz executor

```typescript
// src/gateway/agent-runtime.ts
// W mapie tool executors:
case 'memphis_your_skill':
  return yourSkillHandler(params, context);
```

### Tiery bezpieczeństwa

| Tier  | Wymagania           | Przykłady                                        |
| ----- | ------------------- | ------------------------------------------------ |
| **0** | Brak autoryzacji    | journal, recall, decide, soul_read/write, health |
| **1** | `MEMPHIS_API_TOKEN` | web*fetch, send, vault_get, schedule*\*          |
| **2** | Vault passphrase    | exec, self_modify                                |

### Konwencje nazewnictwa

- Prefix: `memphis_` (np. `memphis_summarize`, `memphis_translate`)
- Snake_case
- Opis po angielsku (system prompt jest anglojęzyczny)
- Input schema: Zod-kompatybilny JSON Schema

### Testowanie nowego skilla

```bash
# Sprawdź czy tool pojawia się w liście
curl -s http://localhost:3000/v1/tools \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" | jq '.[] | .name'

# Test przez MCP
curl -X POST http://localhost:3000/v1/tools/call \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "memphis_your_skill", "arguments": {"input": "test"}}'
```

---

## 2. Zezwolenia self-modyfikacji

Self-modyfikacja (`memphis_self_modify`) pozwala agentowi zmieniać własny kod. Jest to operacja Tier 2 z wieloma safeguardami.

### Pliki konfiguracyjne

#### Soul Manifest (`~/.memphis/config/soul-manifest.json`)

```json
{
  "evolutionPolicy": {
    "autoApprove": false,
    "requirePassphrase": true,
    "snapshotBeforeEvolve": true
  },
  "autonomyMode": "balanced",
  "trustRules": [
    {
      "tool": "memphis_journal",
      "autoApprove": true
    }
  ]
}
```

| Pole                   | Wartość            | Efekt                                    |
| ---------------------- | ------------------ | ---------------------------------------- |
| `autoApprove`          | `false` (domyślne) | Operator musi zatwierdzić każdą ewolucję |
| `autoApprove`          | `true`             | Agent sam zatwierdza (niebezpieczne!)    |
| `requirePassphrase`    | `true` (domyślne)  | Vault passphrase wymagany przed evolve   |
| `snapshotBeforeEvolve` | `true` (domyślne)  | Pełny backup stanu przed zmianami        |

#### Agent Profile (`~/.memphis/config/agent-profile.json`)

```json
{
  "agentName": "Memphis Agent",
  "ownerName": "operator",
  "runtimeMode": "solo-local",
  "toolPolicy": "operator-supervised"
}
```

| `toolPolicy`                                   | Efekt                                 |
| ---------------------------------------------- | ------------------------------------- |
| `"operator-supervised"`                        | Operator zatwierdza Tier 1/2 operacje |
| (inne wartości do implementacji w przyszłości) | —                                     |

#### Autonomy Mode (w soul manifest)

| Mode         | Zachowanie                                                    |
| ------------ | ------------------------------------------------------------- |
| `"quiet"`    | Minimalne proaktywne działania, konserwatywne użycie narzędzi |
| `"balanced"` | Mix guided + autonomous, domyślny                             |
| `"paranoid"` | Wszystkie Tier 1/2 wymagają jawnego approval                  |

### Zmienne środowiskowe

```dotenv
# Całkowicie BLOKUJE exec i self_modify
MEMPHIS_SAFE_MODE=true

# Fail-closed na policy violations
MEMPHIS_STRICT_MODE=true

# Walidacja integralności chain (chroni przed tamperingiem)
MEMPHIS_STRICT_CHAIN_VALIDATION=true
```

| Zmienna               | Domyślna | Efekt na self-modify                              |
| --------------------- | -------- | ------------------------------------------------- |
| `MEMPHIS_SAFE_MODE`   | `false`  | `true` = **całkowita blokada** exec + self_modify |
| `MEMPHIS_STRICT_MODE` | `false`  | `true` = fail-closed, brak fallbacków             |
| `RUST_CHAIN_ENABLED`  | `true`   | `true` = chain integrity check na evolve          |

### Zmiana zezwoleń

```bash
# Tryb 1: Edytuj soul manifest bezpośrednio
nano ~/.memphis/config/soul-manifest.json

# Tryb 2: Przez MCP tool (w runtime)
# memphis_soul_write({ section: "manifest", data: { evolutionPolicy: { autoApprove: false } } })

# Tryb 3: Env var override (natychmiastowy)
MEMPHIS_SAFE_MODE=true npm run dev
```

---

## 3. Trust rules — automatyczne zatwierdzanie

Trust rules w soul manifest pozwalają auto-approve dla bezpiecznych narzędzi:

```json
{
  "trustRules": [
    { "tool": "memphis_journal", "autoApprove": true },
    { "tool": "memphis_recall", "autoApprove": true },
    { "tool": "memphis_decide", "autoApprove": true },
    { "tool": "memphis_health", "autoApprove": true },
    { "tool": "memphis_soul_read", "autoApprove": true }
  ]
}
```

**Zasady:**

- Tier 0 tools mogą być auto-approved bezpiecznie
- Tier 1 tools — rozważ case by case (np. `web_fetch` — tak, `send` — ostrożnie)
- Tier 2 tools (`exec`, `self_modify`) — **nigdy** nie ustawiaj `autoApprove: true` chyba że wiesz co robisz

---

## 4. Blocked paths i safety gates

### Hardcoded blocked paths (nie da się zmienić bez modyfikacji kodu)

Plik: `src/mcp/tools/self-modify.ts`

Self-modify **zawsze** blokuje zmiany w:

| Path                   | Powód                            |
| ---------------------- | -------------------------------- |
| `.env`                 | Sekrety i konfiguracja runtime   |
| `vault/`               | Zaszyfrowane dane                |
| `.git/`                | Integralność repozytorium        |
| `node_modules/`        | Zależności (zmieniane przez npm) |
| Dotfiles (`.`)         | Konfiguracja systemowa           |
| Path traversal (`../`) | Ucieczka z katalogu projektu     |

### Safety gates (7 kroków evolve)

```
1. Walidacja intencji     ← opis zmian wymagany
2. Git check              ← repozytorium git wymagane
3. Passphrase gate        ← Tier 2 auth (jeśli requirePassphrase=true)
4. Snapshot               ← pełny backup (jeśli snapshotBeforeEvolve=true)
5. Branch isolation       ← evolve-* branch (nie main bezpośrednio)
6. Zmiany + test gate     ← lint + typecheck + testy MUSZĄ przejść
7. Merge lub rollback     ← sukces = merge, fail = automatyczny rollback
```

### Sprawdzenie historii ewolucji

```bash
# Lista sesji evolve
npm run -s cli -- evolve status

# System chain (audit trail)
npm run -s cli -- chain query --chain system --content "self_modify"
```

### Przywrócenie po nieudanej ewolucji

```bash
# Automatyczny rollback powinien zadziałać, ale jeśli nie:
git log --oneline -10                    # znajdź commit przed evolve
git checkout main                        # wróć na main
git branch -D evolve-*                   # usuń branch evolve

# Przywróć ze snapshotu (jeśli dostępny)
ls data/snapshots/
# Ręczne przywrócenie wymaga kopiowania plików ze snapshotu
```

---

## Podsumowanie: macierz bezpieczeństwa

| Konfiguracja                                | Efekt                         | Gdzie                |
| ------------------------------------------- | ----------------------------- | -------------------- |
| `MEMPHIS_SAFE_MODE=true`                    | Blokada exec + self_modify    | `.env`               |
| `MEMPHIS_STRICT_MODE=true`                  | Fail-closed                   | `.env`               |
| `evolutionPolicy.autoApprove=false`         | Operator approval             | `soul-manifest.json` |
| `evolutionPolicy.requirePassphrase=true`    | Passphrase gate               | `soul-manifest.json` |
| `evolutionPolicy.snapshotBeforeEvolve=true` | Backup przed zmianami         | `soul-manifest.json` |
| `autonomyMode="paranoid"`                   | Jawny approval na wszystko    | `soul-manifest.json` |
| `toolPolicy="operator-supervised"`          | Operator kontroluje Tier 1/2  | `agent-profile.json` |
| Blocked paths (hardcoded)                   | .env, vault/, .git/ chronione | `self-modify.ts`     |
| Test gate (hardcoded)                       | lint + typecheck + test       | `self-modify.ts`     |

**Rekomendacja dla nowych operatorów:**

```dotenv
# .env — bezpieczne domyślne
MEMPHIS_SAFE_MODE=false
MEMPHIS_STRICT_MODE=false
```

```json
// soul-manifest.json — bezpieczne domyślne
{
  "evolutionPolicy": {
    "autoApprove": false,
    "requirePassphrase": true,
    "snapshotBeforeEvolve": true
  },
  "autonomyMode": "balanced"
}
```

Zaostrzaj (`paranoid`, `SAFE_MODE=true`) dopiero gdy agent działa w niesuperwizowanym środowisku.
