# ARCHITECTURE v0 — Memphis v4

Data: 2026-03-08
Status: Draft v0.1 (basic but working first)

## Cel architektury

Dostarczyć prostą, stabilną strukturę, która:

1. umożliwia szybkie dowiezienie działającego MVP,
2. nie over-engineeruje,
3. pozwala później bezboleśnie rozbudować integracje (w tym Shared/Decentralized LLM).

---

## Zasady projektowe

- **Quality > Speed** (ale bez paraliżu)
- **Modułowość przez granice odpowiedzialności**
- **Adapter pattern dla providerów LLM**
- **Core domain niezależny od konkretnego providera**
- **Najpierw prosty monolit modułowy**, potem ewentualny podział na serwisy

---

## Struktura modułów (v0)

```text
src/
  app/
    bootstrap.ts         # start aplikacji, wiring modułów
    container.ts         # lekki DI / rejestr serwisów

  core/
    types.ts             # typy domenowe
    errors.ts            # błędy domenowe
    contracts/
      llm-provider.ts    # kontrakt providera LLM
      repository.ts      # kontrakt storage

  modules/
    sessions/
      service.ts
      model.ts
    prompts/
      service.ts
      templates.ts
    orchestration/
      service.ts         # flow: request -> provider -> response

  providers/
    shared-llm/
      adapter.ts         # adapter pod shared providers
      client.ts
    decentralized-llm/
      adapter.ts         # adapter pod decentralized providers
      client.ts
    local-fallback/
      adapter.ts         # fallback provider

  infra/
    config/
      env.ts             # walidacja env
      schema.ts          # schema configu
    logging/
      logger.ts
    storage/
      sqlite/
        client.ts
        repositories/
    http/
      server.ts
      routes/
        health.ts
        chat.ts
    cli/
      index.ts

  tests/
    unit/
    integration/
```

---

## Główne warstwy

1. **Core**
   - Czysta logika domenowa i kontrakty.
   - Zero zależności od frameworków.

2. **Modules (Application layer)**
   - Konkretne use-case’y Memphis v4.
   - Spina core + provider + storage.

3. **Providers (Adapter layer)**
   - Implementacje kontraktu `LLMProvider`.
   - Jeden interfejs, wielu dostawców.

4. **Infra**
   - HTTP/CLI, config, logowanie, storage.
   - „Brudne” rzeczy techniczne poza domeną.

---

## Kontrakt providera LLM (high-level)

Każdy provider (shared/decentralized/local) musi wspierać:

- `healthCheck()`
- `generate(input, options)`
- `stream?(input, options)` (opcjonalnie)
- mapowanie błędów do wspólnego formatu domenowego
- timeout/retry policy zgodną z konfiguracją

To pozwala:

- łatwo przełączać providerów,
- robić fallback bez przepisywania core,
- porównywać providerów tym samym testem integracyjnym.

---

## Strategia ewolucji (bez overengineeringu)

### Etap v0 (teraz)

- modułowy monolit,
- 1 aktywny provider + 1 fallback,
- SQLite na start,
- proste API + CLI.

### Etap v1+

- dodatkowe providery,
- PostgreSQL (jeśli wzrośnie skala),
- kolejki/job runner, jeśli będą realne potrzeby.

---

## Definition of Good (dla architektury)

- Każdy moduł ma jasną odpowiedzialność.
- Provider można podmienić bez zmian w `core`.
- Test integracyjny przechodzi dla co najmniej 1 providera.
- Aplikacja uruchamia się komendą `npm run dev` i zwraca health check.
