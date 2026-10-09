# Solana wallet — stan na 2026-10-09

Handoff dla przyszłej sesji. Zmierzone, nie opowiedziane. Każdy punkt ma
falsyfikowalny test albo realny pomiar obok.

---

## 1. CO JUŻ DZIAŁA — `memphis_wallet_sign`

**Commity:** `8f9f4105` (fundament), `f87da8a7` (narzędzie).
**Pliki:** `src/mcp/tools/wallet-sign.ts`, testy `tests/unit/wallet-sign.test.ts`
i `tests/unit/wallet-sign-reference.test.ts`.

Podpisuje dowolne bajty kluczem Ed25519 trzymanym w vault:

```
{ keyName, message (base64), label? }
  -> { signed, publicKey (base58), signature (base64 64 B), messageHash (sha256) }
```

**Zero zależności web3.** Node `crypto` daje dokładnie 64-bajtowy podpis
Ed25519, czyli format jaki Solana oczekuje. Seed to base64 32 B, opakowany
w PKCS#8 przez nagłówek `302e020100300506032b657004220420` + seed.

Zarejestrowane na **wszystkich trzech powierzchniach** (registry, executor,
MCP server) — brama `tool-surface-audit.test.ts` wymusza ich zgodność.
Tier 2, capabilities `['write','execute']`, `isConcurrencySafe: false`.

**Podpisuje, nie broadcastuje.** Świadoma granica zakresu.

### Czego narzędzie odmawia

| Sytuacja                                                  | Zachowanie                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| brak sesji autoryzowanej                                  | `signed:false`, `withVaultSecret` niezawołany                |
| brak wpisu w vault / baza integralności / wyjątek decrypt | `VaultSecretUnavailableError`, callback **nie wykonuje się** |
| seed nie jest base64                                      | `error` zawiera „base64"                                     |
| seed ≠ 32 B                                               | `error` zawiera „32-byte Ed25519 seed"                       |
| pusta wiadomość / brak `keyName`                          | walidacja przed dotknięciem vault                            |

### Weryfikacja podpisu (to jest istotne)

Podpis jest sprawdzany **kryptograficznie** przez `crypto.verify` wobec
pubkey — poprawna długość base64 nie dowodzi niczego.

`wallet-sign-reference.test.ts` przypina pubkey i messageHash do wartości
**wyliczonych poza implementacją** (niezależny skrypt, seed `Buffer.alloc(32,42)`):

```
pubkey     2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ
msgHash    779f3ea020986d8fa5fb02943f84e70db10735a9dbb2251e0af074c834fadae5
```

Dzięki temu zły wrapper PKCS#8 albo zły enkoder base58 nie przejdzie.
base58 pokryty opublikowanymi wektorami (`hello world` → `StV1DL6CwTryKyV`).

Mutacje 4/4 zabite: seed na wyniku, brak walidacji 32 B, brak bramki
autoryzacji, uszkodzony nagłówek PKCS#8.

---

## 2. FUNDAMENT — `withVaultSecret`

**Commit `8f9f4105`.** Plik `src/security/vault-boundary.ts`.

`useVaultSecretByKey` nosił nazwę „bounded-use" i był auditowany jako
`vault.bounded-use`, ale miał ciało **bajt w bajt** jak zwykły read — to samo
`vaultDecrypt`, to samo `plaintext` w wyniku. Różnił go tylko enum w logu.

**Nowy kontrakt:**

```ts
withVaultSecret(key, ctx, fn); // sekret idzie do callbacku, nigdy nie wraca
```

Niedostępny sekret → `VaultSecretUnavailableError`, callback nie startuje.

Trzy konsumentów zmigrowanych: `src/infra/config/vault-resolve.ts`
(galeź env), `src/modules/apps/manifest.ts` (gałąź env **i** gałąź plik).
Martwe gałęzie `resolved.error` / `resolved.plaintext` usunięte.

**Test, który dokumentował bug:** `vault-boundary.test.ts` był nazwany
_„audits bounded-use secret access **without exposing plaintext**"_ i asertował
`plaintext: 'super-secret-token'` na zwróconym obiekcie. Przepisany.

### Zasada, której nie łamać

**Granica musi być strukturą danych, nie konwencją nazwy.** Funkcja, która
nazywa się „bezpieczna", ale zwraca sekret w zwykłej wartości, jest
niebezpieczna — nazwa nie jest granicą. To dotyczy każdego „bounded",
„safe", „internal" w tym repo.

---

## 3. WHITE PAPER SOLANA — co warto wiedzieć

Pobrane realnie: **PDF 689 KB, v0.8.13, 1094 linie**
(`https://solana.com/solana-whitepaper.pdf`). Uwaga: `solana.com/docs/*`
zwraca 404, a strona jest JS-rendered — tekst tylko z PDF.

**Rdzeń mechanizmu:**

- **PoH** (Proof of History) — kryptograficznie weryfikowalny upływ czasu
  osadzony w ledgerze, zamiast zaufania do zegara uczestników
- **PoRep** (Proof of Replication) — dowód replikacji; PoH + PoRep razem bronią
  ledgeru przed podrobieniem względem czasu i pamięci
- **PoS** odporny na partycje dowolnej wielkości

**Liczby — uwaga na źródło.** „710k TPS" to **rachunek z limitu sieci**
(1 Gbps ÷ 176 B), nie benchmark z publicznego sprzętu. Zmierzone na AWS:
2.75m TPS na instancji 1TB x1.16xlarge.

---

## 4. NAJNOWSZE Z SOLANA (news, nie marketing)

- **Samsung Wallet** — stablecoiny na 82M urządzeniach Galaxy (US), od końca
  października 2026
- **Solana DvP** — atomowy settlement (delivery vs payment) dla instytucji,
  open source
- **Microscope** — monitoring programów i alerty do Slack/Telegram/PagerDuty
- slot time 400 → 250 ms
- tokenized equity supply $684 mln, stablecoiny $17.51 mld, 3.18 mld transakcji
  (wrzesień 2026)
- notka „Solana x AI": agentom daje permissionless dostęp do compute, identity,
  **memory** i machine-native payments

---

## 5. PROPOZYCJA INTEGRACJI — wąska, nie „wpnij łańcuch"

Czego **nie** proponujemy: konsensusu, stakingu, TPS. To zupełnie inny
problem niż ten, który Memphis ma.

1. **PoH dla federacji.** Istniejący szkielet Matrix (obecnie wyłączony,
   `MEMPHIS_MATRIX_HOMESERVER` nieustawiony) dostaje append-only łańcuch
   z weryfikowalnym timestampingiem. To dokładnie problem, który PoH rozwiązuje.
2. **Aggregate signatures dla `chain_verify`.** Wzorzec BLS-style zamiast
   pojedynczego hasha — dopiero gdy pojawi się >1 weryfikujący. Przy jednej
   maszynie to koszt bez zysku.
3. **Microscope jako wzorzec na nasz alerting.** Mamy dwa
   `*-failure-alert.service` ucięte do 71 B (nagłówek `[Unit]` + Description,
   bez `[Service]`) — martwe pliki. Ich podejście (program → dashboard → alert)
   jest naszą brakującą warstwą.

---

## 6. CO ZOSTAŁO — następny krok techniczny

**Serializacja transakcji.** `memphis_wallet_sign` podpisuje dowolne bajty, ale
żeby coś wysłać na łańcuch, potrzeba:

- blockhash (obecnie z RPC, nie mamy klienta RPC)
- nagłówki w formacie message (compact-u16 liczby, nazwy kont typu pubkey),
  wiele z nich _po_ podpisaniu (recentBlockhash)
- podpisy w odpowiedniej kolejności, ułożone w polu z nagłówkami
- ewentualnie kompresja (shortvec)

To osobna praca i osobna decyzja. Nie dorzucałem jej po cichu.

**Alternatywa przed budowaniem własnego serializatora:** `@solana/web3.js`.
Sprawdzone 2026-10-09: repo **nie ma** żadnej zależności Solana (`grep` po
`package.json` — zero trafień). Dodanie biblioteki to decyzja o 100+ kB
zależności, więc serializator własny (albo tylko podpis + ręczne wysyłanie
przez curl do RPC) to prawdopodobnie tańszy pierwszy krok.

---

## 7. OTWARTY WĘZEŁ BEZPIECZEŃSTWA (nie zamknięty!)

**`.htpasswd` z realnym hashem hasła jest obecnie serwowany przez GitHub
po starym SHA commita.**

Przebieg 2026-10-09 (szczegóły w journal-696, journal-697):

1. `pii-scan.sh` dostał trzecie ramię na **typy plików** (`.htpasswd`,
   `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`,
   `.age`, `.tfstate`) — BLOCK. Commit `b7bd52a2`.
2. `.gitignore` dostał te same rozszerzenia; wcześniej miał tylko `*.pem`
   i `*.key`.
3. `tests/unit/credential-type-parity.test.ts` wymusza zgodność obu list —
   dwie bramki w dwóch plikach rozjeżdżają się cicho.
4. Historia oczyszczona `git-filter-repo --invert-paths`, force-push wykonany.
   `main` czysty: `gh api contents/...htpasswd` → **404**.
5. **ALE:** stary commit nadal istnieje jako nieosiągalny obiekt i
   `raw.githubusercontent.com/.../<stary-SHA>/...htpasswd` zwraca **HTTP 200**.

Zero forków, więc blast radius jest mały (czytelnicy repo), ale hash jest
publiczny i `/docs/internal` realnie chroniony.

**Do zrobienia:** rotacja hasła (bcrypt jest poza granicą, offline cracking
realny) + zgłoszenie do GitHub Support w celu usunięcia obiektu.
Kopia bezpieczna: `~/.memphis/site-secrets/memphis-v5-docs-internal.htpasswd` (0600).

---

## 8. TRZY NAUKI Z TEJ SESJI (osobne od kodu)

1. **`git commit` bierze CAŁY INDEKS, nie tylko pliki które właśnie dodałem.**
   Trzy razy w jednej sesji `git add sites/` (lub cudzy staging) wciągnęło
   186–199 plików do mojego commita, raz z `.htpasswd`. `git diff --cached
--name-only` przed commitem to obowiązek, nie formalność.

2. **Dwie równoległe sesje na jednym repo to realne ryzyko, nie teoretyczne.**
   Druga sesja (`Wodzu (Marcin Kukla)`) commitowała `sites/` w trakcie mojej
   pracy. Zmieniała HEAD podczas gdy pisałem testy. Nie zgadywałem — sprawdziłem
   `git log --format='%an %ad'`.

3. **`grep -vE ''` z pustą listą wyjątków kasuje WSZYSTKIE linie.** Pusta lista
   wyjątków w nowym ramieniu `pii-scan.sh` po cichu wyłączyła całą ochronę.
   Wyłapały to testy, nie analiza kodu. `a^` nigdy nie pasuje — bezpieczny no-op.

---

## 9. JAK TO ZWERYFIKOWAĆ PRZY KONIECU PRACY

```bash
cd ~/memphis
npx tsc --noEmit -p tsconfig.json                 # 0 błędów
npx vitest run tests/unit/wallet-sign.test.ts \
             tests/unit/wallet-sign-reference.test.ts \
             tests/unit/vault-boundary.test.ts \
             tests/unit/credential-type-parity.test.ts \
             tests/unit/pii-scan.test.ts          # 36 testów
npx vitest run tests/unit                          # pełny suite
bash scripts/pii-scan.sh                           # musi być 0 lub tylko ADVISORY
npm run -s ops:mutation-gate                       # 5/5
md5sum .env                                        # 8448f8b8bdbb7f2969177ad07d13920a
```

Ten ostatni md5 to kontrakt izolacji: identyczny przed i po pełnym suite
oznacza, że testy nie tknęły produkcyjnej konfiguracji.
