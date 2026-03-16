# Memphis — Refactoring Guide

> Wygenerowano: 2026-03-16 | Dotyczy: `/home/memphis_ai_brain_on_chain/memphis`

---

## 1. Architecture Overview

Memphis to agent runtime z pięciowarstwową architekturą:

```
┌─────────────────────────────────────────────────┐
│  bin/memphis.js  (CLI entry)                    │
├─────────────────────────────────────────────────┤
│  App Layer          app/bootstrap.ts            │
│                     app/container.ts (DI)       │
├─────────────────────────────────────────────────┤
│  Infra Layer                                    │
│    ├── cli/         Commands, handlers, TUI     │
│    ├── http/        Fastify server, routes      │
│    ├── storage/     SQLite, chain, vault, WAL   │
│    ├── logging/     Metrics, audit, alerts      │
│    ├── config/      Env parsing, schema         │
│    └── runtime/     Security guards, safe mode  │
├─────────────────────────────────────────────────┤
│  Core Layer         core/contracts, types, errs │
├─────────────────────────────────────────────────┤
│  Modules Layer                                  │
│    ├── orchestration/  Provider resolution      │
│    ├── apps/           Manifest management      │
│    └── sessions/       Session lifecycle        │
├─────────────────────────────────────────────────┤
│  Domain Layer                                   │
│    ├── cognitive/   Models A-E, patterns        │
│    ├── providers/   LLM provider abstraction    │
│    ├── gateway/     Chat loop, MCP bridge       │
│    ├── security/    Policy enforcement          │
│    ├── decision/    Decision primitives         │
│    └── sync/        Workspace sync              │
├─────────────────────────────────────────────────┤
│  Rust Crates        crates/                     │
│    ├── memphis-core   Chain integrity           │
│    ├── memphis-vault  Encrypted storage         │
│    ├── memphis-embed  Embeddings pipeline       │
│    └── memphis-napi   Node.js NAPI bridge       │
└─────────────────────────────────────────────────┘
```

**Kluczowe przepływy:**
- CLI: `bin/memphis.js` → `infra/cli/index.ts` → handlers → storage/domain
- HTTP: `app/bootstrap.ts` → `infra/http/server.ts` → routes → storage/domain
- Chain: `infra/storage/chain-adapter.ts` → Rust bridge (fallback: TS)

---

## 2. Code Smells

### 2.1 God Classes / Monolity

| Plik | Linie | Problem |
|------|-------|---------|
| `src/infra/http/server.ts` | **1 178** | 30+ routes w jednej funkcji `createHttpServer()`. Routing, auth, validation, vault, dual-approval, soul ops — wszystko w jednym pliku |
| `src/modules/apps/manifest.ts` | **1 139** | Monolityczny katalog aplikacji z dużymi lookup tables |
| `src/cognitive/patterns.ts` | **934** | 1000+ regex patterns w jednym pliku |
| `src/infra/cli/utils/doctor-v2.ts` | **848** | 6 tier'ów diagnostycznych w jednej klasie |
| `src/tui/index.ts` | **838** | Cały TUI w jednym module — state + rendering |
| `src/infra/cli/commands/backup.ts` | **750** | Backup logic niezmodularyzowany |
| `src/cognitive/model-d.ts` | **699** | Złożona koordynacja zbiorowa |

### 2.2 Duplikacja kodu

**Bridge loading** — ten sam wzorzec w 3 plikach:
- `src/infra/storage/chain-adapter.ts:31-40` — `tryLoadRustBridge()`
- `src/infra/storage/rust-chain-adapter.ts:150-165` — `loadBridge()`
- `src/infra/storage/rust-vault-adapter.ts:113-133` — kolejna kopia

**`parseBool()` zdefiniowany dwukrotnie:**
- `src/infra/logging/metrics.ts:56`
- `src/infra/storage/chain-adapter.ts:22`

**`parseEnvelope<T>()` zduplikowany:**
- `src/infra/storage/rust-chain-adapter.ts:127-143`
- `src/infra/storage/rust-vault-adapter.ts` — ten sam wzorzec

### 2.3 Bezpieczeństwo typów

| Lokalizacja | Problem |
|-------------|---------|
| `src/infra/storage/rust-chain-adapter.ts:130` | `JSON.parse(raw) as BridgeEnvelope<T>` — unsafe cast bez walidacji runtime |
| `src/infra/http/server.ts:273` | `request as typeof request & { __startedAtMs?: number }` — mutacja typu request |
| `src/infra/storage/chain-adapter.ts:273-274` | Legacy hash fallback bez type safety |

### 2.4 Silent error swallowing

```typescript
// src/app/bootstrap.ts:500-503
try {
  const reflections = await engine.reflectDaily('scheduled', new Map());
} catch {
  // Reflection is best-effort — don't crash the server
}

// src/gateway/chat-loop.ts:89-91
} catch (err) {
  log.warn({ err }, 'rust loop step failed — falling back to TS');
}
```

**Problem:** Krytyczne błędy są połykane. Fallback do TS bez śladu audytu to potencjalna luka bezpieczeństwa.

### 2.5 Rozsypany `process.env`

**65 plików** czyta `process.env` bezpośrednio. Brak centralnej walidacji env variables. Przykłady:
- `src/app/bootstrap.ts:48` — bezpośredni dostęp przed załadowaniem configu
- `src/infra/http/server.ts:117, 245` — wielokrotne odczyty bez defaults

### 2.6 Magic numbers / hard-coded values

| Lokalizacja | Wartość | Kontekst |
|-------------|---------|----------|
| `src/infra/storage/task-queue-wal.ts:36` | `10 * 1024 * 1024` | Max WAL size — brak komentarza |
| `src/infra/storage/task-queue-wal.ts:50` | `0x82f63b78` | CRC32C polynomial — brak referencji |
| `src/gateway/chat-loop.ts:45` | `max_steps: 32` | Dlaczego 32? |
| `src/gateway/chat-loop.ts:46` | `max_tool_calls: 16` | Brak dokumentacji |
| `src/gateway/chat-loop.ts:505-509` | `5 * 60 * 1000` | Reflection timing |

### 2.7 Brak abstrakcji

**CLI Handlers** — brak wspólnego interfejsu:
- `src/infra/cli/handlers/storage.handler.ts` (430 linii) — mix chain, onboarding, trade, soul
- Każdy handler to osobny namespace z innym API

**Cognitive Models** — Model A, B, C, D, E (500-700 linii każdy):
- Brak wspólnego `CognitiveModel` interfejsu
- Różne wzorce API między modelami

### 2.8 Potencjalne wycieki zasobów

```typescript
// src/infra/storage/chain-adapter.ts:129-166
const tmpFilename = `${filename}.tmp-${process.pid}-${Date.now()}`;
await fs.writeFile(tmpFilename, payload, 'utf8');
try {
  await fs.rename(tmpFilename, filename);
} catch (error) {
  await fs.unlink(tmpFilename).catch(() => undefined); // silent fail
  throw error;
}
```

Jeśli `unlink()` zawiedzie, pliki tymczasowe narastają.

### 2.9 Wyłączone reguły lintingu

```javascript
// eslint.config.mjs
'max-lines-per-function': 'off',  // WYŁĄCZONE
'complexity': 'off',               // WYŁĄCZONE
```

To maskuje problemy z wielkością i złożonością funkcji.

---

## 3. Priority Matrix

### HIGH — zrób najpierw

| # | Task | Pliki | Uzasadnienie |
|---|------|-------|-------------|
| H1 | **Rozbij `server.ts` na moduły route** | `src/infra/http/server.ts` | 1 178 linii, god class, blokuje testowanie |
| H2 | **Scentralizuj env access** | 65 plików z `process.env` | Ryzyko runtime errors, brak walidacji |
| H3 | **Wyciągnij shared utilities** | `parseBool`, `parseEnvelope`, bridge loading | Duplikacja = rozbieżność |
| H4 | **Dodaj structured error logging** | `bootstrap.ts:500-503`, `chat-loop.ts:89-91` | Silent failures = security blind spots |
| H5 | **Unsafe JSON.parse → runtime validation** | `rust-chain-adapter.ts:130`, `rust-vault-adapter.ts` | Chain integrity depends on this |

### MEDIUM — po stabilizacji HIGH

| # | Task | Pliki | Uzasadnienie |
|---|------|-------|-------------|
| M1 | **Rozbij `doctor-v2.ts` na tier modules** | `src/infra/cli/utils/doctor-v2.ts` | 848 linii, 6 niezależnych tier'ów |
| M2 | **Wyciągnij TUI na komponenty** | `src/tui/index.ts` | 838 linii monolitu |
| M3 | **Ustandaryzuj CLI handler interface** | `src/infra/cli/handlers/*.ts` | Niespójne API, brak kontraktu |
| M4 | **Stwórz `CognitiveModel` interface** | `src/cognitive/model-{a,b,c,d,e}.ts` | 5 modeli bez wspólnego interfejsu |
| M5 | **Rozbij `manifest.ts`** | `src/modules/apps/manifest.ts` | 1 139 linii, dane + logika razem |
| M6 | **Wyciągnij magic numbers do config** | `task-queue-wal.ts`, `chat-loop.ts` | Nieudokumentowane stałe |

### LOW — polish

| # | Task | Pliki | Uzasadnienie |
|---|------|-------|-------------|
| L1 | **Rozbij `patterns.ts` per-category** | `src/cognitive/patterns.ts` | 934 linii danych |
| L2 | **Refactor `backup.ts`** | `src/infra/cli/commands/backup.ts` | 750 linii, ale działa |
| L3 | **Włącz `max-lines-per-function` i `complexity`** | `eslint.config.mjs` | Po refaktoryzacji monolitów |
| L4 | **Cleanup temp file handling** | `chain-adapter.ts:129-166` | Edge case, ale resource leak |

---

## 4. Patterns to Apply

### 4.1 Route Module Pattern (dla H1)

**Przed:**
```typescript
// server.ts — 1 178 linii, wszystko w jednym
export async function createHttpServer(deps: ServerDeps) {
  app.post('/api/vault/encrypt', async (req, reply) => { ... });
  app.post('/api/vault/decrypt', async (req, reply) => { ... });
  app.post('/api/dual-approval/request', async (req, reply) => { ... });
  // ... 30+ routes
}
```

**Po:**
```typescript
// src/infra/http/routes/vault.routes.ts
export function registerVaultRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post('/api/vault/encrypt', encryptHandler(deps));
  app.post('/api/vault/decrypt', decryptHandler(deps));
}

// src/infra/http/routes/dual-approval.routes.ts
export function registerDualApprovalRoutes(app: FastifyInstance, deps: RouteDeps) { ... }

// src/infra/http/routes/index.ts
export function registerAllRoutes(app: FastifyInstance, deps: RouteDeps) {
  registerVaultRoutes(app, deps);
  registerDualApprovalRoutes(app, deps);
  registerSoulRoutes(app, deps);
  registerAdminRoutes(app, deps);
}

// server.ts — teraz ~100-150 linii
export async function createHttpServer(deps: ServerDeps) {
  const app = fastify(opts);
  registerAllRoutes(app, deps);
  return app;
}
```

### 4.2 Centralized Config (dla H2)

**Przed:** 65 plików z bezpośrednim `process.env`.

**Po:**
```typescript
// src/infra/config/env.ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  RUST_CHAIN_ENABLED: z.coerce.boolean().default(true),
  WAL_MAX_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  MAX_TOOL_CALLS: z.coerce.number().default(16),
  MAX_STEPS: z.coerce.number().default(32),
  REFLECTION_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  // ...
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) _env = EnvSchema.parse(process.env);
  return _env;
}
```

### 4.3 Shared Bridge Loader (dla H3)

```typescript
// src/infra/storage/bridge-loader.ts
import { logger } from '../logging';

let _bridge: NativeBridge | null = null;

export function loadRustBridge(): NativeBridge | null {
  if (_bridge) return _bridge;
  try {
    _bridge = require('../../../native/index.node');
    return _bridge;
  } catch (err) {
    logger.warn({ err }, 'Rust bridge unavailable — using TS fallback');
    return null;
  }
}

export function parseBool(val: string | undefined, fallback = false): boolean {
  if (!val) return fallback;
  return ['1', 'true', 'yes'].includes(val.toLowerCase());
}

export function parseEnvelope<T>(raw: string): BridgeEnvelope<T> {
  const parsed: unknown = JSON.parse(raw);
  // Runtime validation with zod
  return BridgeEnvelopeSchema.parse(parsed) as BridgeEnvelope<T>;
}
```

### 4.4 CognitiveModel Interface (dla M4)

```typescript
// src/cognitive/cognitive-model.ts
export interface CognitiveModel {
  readonly name: string;
  readonly version: string;
  process(input: CognitiveInput): Promise<CognitiveOutput>;
  reflect?(context: ReflectionContext): Promise<Reflection>;
}

export interface CognitiveInput {
  content: string;
  context: Map<string, unknown>;
  constraints?: CognitiveConstraints;
}

export interface CognitiveOutput {
  result: string;
  confidence: number;
  metadata: Record<string, unknown>;
}
```

### 4.5 CLI Handler Contract (dla M3)

```typescript
// src/infra/cli/handlers/handler.ts
export interface CommandHandler<TInput, TOutput> {
  readonly command: string;
  validate(input: TInput): ValidationResult;
  execute(input: TInput): Promise<TOutput>;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}
```

### 4.6 Error Boundary Pattern (dla H4)

```typescript
// Zamiast silent catch:
try {
  const reflections = await engine.reflectDaily('scheduled', new Map());
} catch (err) {
  log.error({ err, context: 'daily-reflection' }, 'Reflection failed — degraded mode');
  metrics.increment('reflection.failure');
  // Opcjonalnie: alerting na powtarzające się błędy
}
```

---

## 5. Testing Strategy

### Zasady ogólne

1. **Izolacja**: Każdy test używa `MEMPHIS_DATA_DIR` w temp directory
2. **Determinizm**: `RUST_CHAIN_ENABLED=false` dla TS chain writes w testach
3. **Brak mocków bazy**: Testuj na prawdziwym SQLite (in-memory lub temp file)

### Strategia per-refactoring

| Refactoring | Test approach |
|-------------|---------------|
| **H1: Route modules** | Stwórz integration testy per-route module. Użyj `app.inject()` Fastify do testowania bez HTTP. Pokryj: happy path, auth rejection, validation errors |
| **H2: Centralized env** | Unit testy `getEnv()` z różnymi kombinacjami. Testy na brakujące required vars. Snapshot test domyślnych wartości |
| **H3: Shared utilities** | Unit testy `parseBool`, `parseEnvelope`, `loadRustBridge`. Testy na edge cases: malformed JSON, missing bridge |
| **H4: Error logging** | Sprawdź że logger jest wywołany z prawidłową strukturą. Użyj `pino.destination(new PassThrough())` do przechwycenia logów |
| **H5: Runtime validation** | Fuzz testy z losowym JSON. Property-based testing na `parseEnvelope` |

### Nowe testy do dodania

```
tests/
├── integration/
│   ├── http/
│   │   ├── vault-routes.test.ts        # NOWE
│   │   ├── dual-approval-routes.test.ts # NOWE
│   │   ├── soul-routes.test.ts          # NOWE
│   │   └── admin-routes.test.ts         # NOWE
│   └── storage/
│       └── bridge-loader.test.ts        # NOWE
├── unit/
│   ├── config/
│   │   └── env.test.ts                  # NOWE
│   └── shared/
│       ├── parse-bool.test.ts           # NOWE
│       └── parse-envelope.test.ts       # NOWE
```

### Coverage gates

Po refaktoryzacji włącz w `vitest.config.ts`:
```typescript
coverage: {
  thresholds: {
    lines: 70,
    branches: 60,
    functions: 70,
  }
}
```

---

## 6. Migration Steps

### Faza 1: Fundament (tydzień 1-2)

```
Krok 1.1 — Centralized env
  ├── Stwórz src/infra/config/env.ts z Zod schema
  ├── Dodaj testy unit: tests/unit/config/env.test.ts
  ├── Zamień process.env w 5 najkrytyczniejszych plikach:
  │   ├── src/app/bootstrap.ts
  │   ├── src/infra/http/server.ts
  │   ├── src/infra/storage/chain-adapter.ts
  │   ├── src/infra/logging/metrics.ts
  │   └── src/gateway/chat-loop.ts
  ├── Odpal pełny test suite: npm run test:ts
  └── Commit: feat(config): centralize env access with Zod validation

Krok 1.2 — Shared utilities
  ├── Stwórz src/infra/storage/bridge-loader.ts
  ├── Przenieś parseBool, parseEnvelope, loadRustBridge
  ├── Zaktualizuj importy w:
  │   ├── src/infra/storage/chain-adapter.ts
  │   ├── src/infra/storage/rust-chain-adapter.ts
  │   ├── src/infra/storage/rust-vault-adapter.ts
  │   └── src/infra/logging/metrics.ts
  ├── Dodaj runtime validation (Zod) do parseEnvelope
  ├── Testy: tests/unit/shared/bridge-loader.test.ts
  └── Commit: refactor(storage): extract shared bridge utilities

Krok 1.3 — Error logging
  ├── Zamień silent catches na structured logging w:
  │   ├── src/app/bootstrap.ts:500-503
  │   ├── src/gateway/chat-loop.ts:89-91
  │   └── src/infra/storage/task-queue-service.ts:83-114
  ├── Dodaj metryki: reflection.failure, bridge.fallback
  └── Commit: fix(observability): replace silent catches with structured logging
```

### Faza 2: Server decomposition (tydzień 3-4)

```
Krok 2.1 — Przygotuj strukturę route
  ├── Stwórz katalog src/infra/http/routes/
  ├── Stwórz typy: src/infra/http/routes/types.ts (RouteDeps interface)
  └── Commit: refactor(http): scaffold route module structure

Krok 2.2 — Wyciągnij vault routes
  ├── Przenieś vault endpoints do src/infra/http/routes/vault.routes.ts
  ├── Dodaj test: tests/integration/http/vault-routes.test.ts
  ├── Zweryfikuj: npm run test:ts && npm run lint
  └── Commit: refactor(http): extract vault routes

Krok 2.3 — Wyciągnij dual-approval routes
  ├── Przenieś do src/infra/http/routes/dual-approval.routes.ts
  ├── Test: tests/integration/http/dual-approval-routes.test.ts
  └── Commit: refactor(http): extract dual-approval routes

Krok 2.4 — Wyciągnij soul routes
  └── Analogicznie

Krok 2.5 — Wyciągnij admin/health routes
  └── Analogicznie

Krok 2.6 — Cleanup server.ts
  ├── server.ts teraz ~100-150 linii (setup + middleware + register routes)
  ├── Pełny regression: npm run test:ts
  └── Commit: refactor(http): finalize server decomposition
```

### Faza 3: CLI & Cognitive (tydzień 5-6)

```
Krok 3.1 — CLI handler interface
  ├── Stwórz src/infra/cli/handlers/handler.ts (interface)
  ├── Zaimplementuj w 2-3 handlerach jako proof of concept
  └── Commit: refactor(cli): introduce handler interface

Krok 3.2 — CognitiveModel interface
  ├── Stwórz src/cognitive/cognitive-model.ts
  ├── Zaimplementuj w Model A i Model B jako PoC
  └── Commit: refactor(cognitive): introduce CognitiveModel interface

Krok 3.3 — Doctor-v2 decomposition
  ├── Rozbij na src/infra/cli/utils/doctor/tier-{1..6}.ts
  ├── doctor-v2.ts staje się orchestratorem
  └── Commit: refactor(cli): decompose doctor into tier modules

Krok 3.4 — TUI decomposition
  ├── Rozbij src/tui/index.ts na komponenty:
  │   ├── src/tui/screens/
  │   ├── src/tui/state/
  │   └── src/tui/renderer.ts
  └── Commit: refactor(tui): decompose into screen components
```

### Faza 4: Polish (tydzień 7-8)

```
Krok 4.1 — Extract magic numbers
  ├── Przenieś do src/infra/config/constants.ts
  ├── Udokumentuj każdą stałą
  └── Commit: refactor(config): extract and document magic constants

Krok 4.2 — Enable lint rules
  ├── Włącz max-lines-per-function: ['warn', { max: 200 }]
  ├── Włącz complexity: ['warn', { max: 20 }]
  ├── Napraw pozostałe violations
  └── Commit: chore(lint): enable complexity and function size rules

Krok 4.3 — Coverage gates
  ├── Dodaj coverage thresholds do vitest.config.ts
  ├── Uzupełnij brakujące testy
  └── Commit: test: add coverage thresholds
```

### Zasady bezpieczeństwa migracji

1. **Jeden commit = jedna zmiana** — nigdy nie łącz refaktoryzacji z feature work
2. **Green tests na każdym kroku** — `npm run test:ts && npm run lint` przed każdym commit
3. **Feature flags na duże zmiany** — jeśli refactoring trwa >1 dzień, użyj brancha
4. **Backward compatibility** — stare importy działają przez re-export (tymczasowo)
5. **Review chain integrity** — po każdej zmianie w storage layer: `npm run test:chaos`
6. **Nie refaktoryzuj i nie naprawiaj bugów jednocześnie** — osobne commity

---

## Appendix: File Impact Map

```
HIGH IMPACT (dotknij ostrożnie):
  src/infra/http/server.ts          ← 1178 LOC, 30+ routes
  src/app/bootstrap.ts              ← 510 LOC, startup orchestration
  src/infra/storage/chain-adapter.ts ← 504 LOC, chain integrity

MEDIUM IMPACT (refactor z testami):
  src/cognitive/model-{a..e}.ts     ← 500-700 LOC each
  src/infra/cli/utils/doctor-v2.ts  ← 848 LOC
  src/tui/index.ts                  ← 838 LOC
  src/modules/apps/manifest.ts      ← 1139 LOC

LOW IMPACT (safe to change):
  src/cognitive/patterns.ts         ← 934 LOC, data only
  src/infra/cli/commands/backup.ts  ← 750 LOC
  eslint.config.mjs                 ← config
```
