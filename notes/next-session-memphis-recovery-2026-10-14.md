# Memphis plan odzyskania działania

Data: 2026-10-14. Zapis na prośbę operatora: „zapisz i zapamietaj”.

Najpierw przywrócić działającą instalację z istniejącymi sekretami, tożsamością
i pamięcią, następnie domykać refaktor małymi, sprawdzonymi zmianami. Pierwszy
cel: Memphis działa po restarcie procesu, odczytuje istniejące dane, odpowiada
przez MiniMax, a przyczyna ponownej awarii vaulta jest wyjaśniona.

Repozytorium: `/home/memphis/memphis`. Gałąź podczas przeglądu:
`fix/embed-persistence-and-chain-parse`; HEAD: `7c51f1a7`.
„Memphis” w rozmowie oznacza ten projekt.

## Bieżący checkpoint — 2026-10-18

CLI secret errors wdrożone i lokalnie sprawdzone: 37 TS / 3 pliki, doctor
47 pass / 13 warn / 0 fail / 0 requiredFailures, TUI OK, NRestarts0.
MiniMax próby 500, 200, 200; dwie ostatnie z dokładnym markerem, ostatnia po
świeżym restarcie. Przyczyna pierwszego 500 nieustalona; journal tylko
INTERNAL_ERROR. Wszystkie próby zachowane w verification-final.json.
Dowód/rollback: `/home/memphis/.memphis-backup-s1-cli-errors-kn75azc3`.
Chronione pliki, indeks bezpośrednio sprzed wdrożenia i native zachowane.
CLI add/get/list mają stałe publiczne błędy i znane kody; --json obiekt,
awaria/brak żądanego klucza exit1, sukces exit0. Zachowuje 101–103 i krytyczny
exit; nie wywołuje getterów. Auth/required args nadal poza tym mapperem.
Testy: 23 unit + 5 izolowanych realnych procesów handlera + 9 czytników.
To nie jest dowód całego launchera/native finalizer stress ani release observation.

Native Debug: `/home/memphis/.memphis-backup-s1-native-debug-4htu6p5v`
(`.git/memphis-s1-native-debug-work`). Dziesięć jawnych bezpiecznych projekcji
Debug w 5 plikach; 10 testów fail przed, pass po. Serde/Clone/Eq i prywatny
wire-format bez zmian, recovery verify nadal działa. Brak dowodu aktywnego wycieku.
Pełny izolowany offline cargo workspace: exit0, 475 pass / 0 fail / 2 ignored
w 27 raportach. Źródła i protected niezmienione. Indeks zmienił 50 wpisów podczas
runu (autor nieustalony); nie przywracano. Lista: index-semantic-verification.json.
Przed buildem ponownie potwierdzono identyczne źródła Rust z testowanymi.
Nowy private build NAPI/TUI/example i typecheck PRZESZŁY.
Frozen acceptance 86 plików TS: 577 pass / 0 fail / 0 skip. Źródła, protected
oraz nowy indeks sprzed acceptance zachowane. Dwa native artefakty WDROŻONE,
bez zmiany JS. Dwa starty healthy/invalid0, doctor47/13/0/requiredFailures0,
TUI OK, NRestarts0. MiniMax HTTP200/exact MEMPHIS_S1_NATIVE_DEBUG_OK.
verification-final.json potwierdza źródła/protected/index i zgodność obu binary
po canary. Rollback: deploy.py --rollback; wycofać przed starszymi scope.
Scoped rustfmt 5 plików pass; full fmt ma wcześniejsze różnice memphis-core,
staged whitespace ma istniejącą pustą linię EOF w AGENTS.md. Nie deklarować
całego formatowania repo jako zaliczonego.
Target prywatny `/home/memphis/.memphis-backup-journal-contract-b4_xrqby/target-next`.
Nie scripts/run-rust.sh (kopiuje aktywne artefakty), używać with-local-rust.

Legacy init result — WDROŻONE i odebrane:
`/home/memphis/.memphis-backup-s1-init-result-48rmh49r`
(`.git/memphis-s1-init-result-work`). Syntetyczny CJS bridge potwierdził
forwarding master_key_hash/error/nested przez adapter/facade aż do HTTP.
Nowy test: baseline9fail/1pass, po naprawie10pass. Final69TS/7plików,
strict build, scoped lint JSON0errors/0warnings, format i diff pass.
Adapter waliduje version1/2 + niepusty string did i zwraca tylko {version,did}.
Nie zmieniono prywatnych serde pól ani persisted credential/recovery formatów.
Pierwszy preflight zatrzymał się przed stop przez istniejące ESLintIgnoreWarning;
poprawiono gate na raport JSON, ostrzeżenie zachowano. Wdrożono jeden JS,
native bez zmian. Dwa starty healthy, doctor47/13/0, TUI OK, NRestarts0;
MiniMax HTTP200/exact MEMPHIS_S1_INIT_RESULT_OK. verification-final.json:
source/protected/index/native bez zmian, deployedJS zgodny. Bez live init/reset.

V11 launch paths — WDROŻONE i odebrane lokalnie:
`/home/memphis/.memphis-backup-s1-launch-paths-_thxse11`
(`.git/memphis-s1-launch-paths-work`). Z kodu: rust-paths-bridge przekazuje
process.cwd() dla względnego MEMPHIS_DATA_DIR, native używa runtime_root.
Dodano izolowany Rust example runtime-path-fixture i guarded TS child fixture
oraz tests/integration/runtime-launch-paths.test.ts: home/Work/other-project,
clean/inherited env, jawny override po kolejnym starcie i transient systemd user
service (skip tylko bez Linux/user bus). Synthetic v2 vault, shadow cwd dotenv,
sprawdzenie TS/native paths/provenance/generation/read oraz unchanged bytes.
Nowy example build w prywatnym target przeszedł. Baseline:7fail/1pass,
wszystkie względne data paths szły do launch-cwd/data; absolute overrides pass.
Dodano pathResolutionBase w rust-paths-bridge dla data/chains/chain calls:
MEMPHIS_RUNTIME_ROOT wins, brak override zachowuje cwd semantykę. Testy porównują
kanonicznie równoważne ścieżki (Rust PathBuf zachowuje ./ w reprezentacji).
51 testów TS / 9 plików przeszło, zero failed/skipped; wszystkie 8 nowych przypadków,
w tym rzeczywista tymczasowa usługa user systemd. Scoped build/lint/format i rustfmt
example przeszły. Helper .mts lintowany przez stdin z wirtualną nazwą .ts.
Wdrożono jeden JS; native bez zmian. Dwa starty healthy, doctor47/13/0,
requiredFailures0, TUI OK, NRestarts0, MiniMax HTTP200/exact MEMPHIS_S1_LAUNCH_PATHS_OK.
verification-final.json potwierdza source/protected/index/native i zgodność JS.
Rollback deploy.py --rollback; cofać przed init-result/native-debug i starszymi.
To lokalna część V11 dotycząca wyboru ścieżek, nie pełny odbiór pamięci/release.

Następny krok V01: wspólna ochrona wszystkich writerów dotenv. Starsze
upsertEnvVars/removeEnvVars blokują tylko dziennik env i pomijają guard peppera;
potwierdzić regresją na izolowanym fixture przed zmianą. Następnie porównać
odmowy CLI/MCP/HTTP/TUI oraz odczyt credential w tym samym i nowym procesie.

S1.4/S1.7 i pełne V01–V04/V11 nadal otwarte. Cały S1–S9 nieukończony.
HEAD ostatnio rechecked 10fac3d8, bez commita/push w tej sesji.

## S1.4: wspólny fixture czytników — wdrożone 2026-10-18

Źródła i dowody: `/home/memphis/.memphis-backup-s1-reader-surfaces-ftm_zdu0` (`.git/memphis-s1-reader-surfaces-work`). Finalnie 75
różnych testów TS w 8 plikach: 74 w głównym run + 1 dodatkowy brakujący klucz;
9-case run fixture nakłada się na wcześniejsze 8, nie dodawać 74+9.
Wspólny szyfrowany fixture sprawdza named/raw/bounded/HTTP/CLI/MCP/native dla
v1 readable, brak/malformed/auth stanu, wersjaunsupported, missingpepper,
auth wpisu, UTF8 oraz różnicę brakującego klucza vs jawne rawdecrypt.
Native8+missingkey są wywołaniami procesu w testach TS, nie nowymi Rust unit tests.
Autoryzacja CLI/MCP w fixture mocked; osobne suite polityki przeszły wcześniej.

Początkowo 5/6 fixture fail + 1 missing-state wykazały gubienie kodów w raw/
HTTP/CLI/bounded. Wspólny klasyfikator rekonstruuje znane kody state/entry/bridge,
bounded wyjątek ma errorCode, raw failure errorCode -> HTTP code; CLI --json get
błąd jest obiektem JSON. MCP interface deklaruje istniejące errorCode. Dodatkowe
5 unit cases pokrywa state/entry/bridge/unknown/tampered code bez secret context.
Komentarze config/apps poprawiono: callback może zwrócić i zachować plaintext.
Dwa comment-only AST i ręczny diff potwierdzone; wcześniejszy naiwny scanner
porównań tokenów zwrócił fałszywy alarm i nie jest dowodem odbioru.

Strict TS build, lint/format/diff przeszły. Wdrożono 5 JS: 3 funkcjonalne boundary/
HTTP/CLI i 2 comment-only config/apps. MCP typ nie zmienił JS. Native bez zmian.
Dwa starty healthy, invalid0, doctor47/13/0/requiredFailures0, TUI OK, NRestarts0.
MiniMax HTTP200 i dokładny MEMPHIS_S1_4_READERS_OK; końcowe chronione hashe,
indeks i native zachowane po canary (verification-final.json). Bez commita/push.
Nie deklarować pełnego S1. Następny scope CLI naprawia opisane niżej JSON/exit.
S1-CREDENTIAL-READERS.md jest nową inwentaryzacją źródeł i umów.

Dalej: CLI secret add/list --json nadal nie daje strukturalnego wyniku awarii,
a stare ścieżki add/get zwracają exit0 przy błędzie. Potwierdzić fixture przed
zmianą; dla wyjątków list/get zachować nonzero oraz kody bootstrap101–103.
Testy bezpośrednich wywołań handlera muszą przy zmianie process.exitCode zapisywać
i przywracać flagę, szczególnie nowy helper cliRead w shared-reader fixture.

## S1.7: atomic cleanup — wdrożone 2026-10-18

51 różnych testów w 6 plikach przeszło (wcześniejsze 37 nakłada się). Trzy nowe
regresje najpierw potwierdziły stderr context i zastąpienie primary przez close;
czwarty przypadek chroni primary przy awarii samego stderr. Zamknięty errno
wspólny dla recordera i cleanup, bez getterów/contextu; failed unlink pozostawia
prywatny tmp — nie deklarować usuniętego. Initial lint import-order poprawiono;
preflight zatrzymał format przed stopem usługi, potem Prettier/strict rebuild/
source hash/lint/format przeszły. Wdrożono 3 JS w tym nowy io-error-code.js;
rollback ma jawnie usuwać nowy helper po przywróceniu importerów. Native bez zmian.
Dwa starty healthy, invalid0; doctor47/13/0/requiredFailures0, TUI OK, NRestarts0.
MiniMax HTTP200 i dokładny MEMPHIS_S1_7_ATOMIC_OK. Chronione pliki, indeks
sprzed wdrożenia i NAPI/TUI bez zmiany po canary. Dowody: `/home/memphis/.memphis-backup-s1-atomic-errors-50z0o5x6`.
Bez commita/push. Cofać atomic przed HTTP/audit/H3/wallet/audit/aliasami/cache.
Pełny S1 i bramki trwałości/power-loss nadal otwarte.

## S1.7: HTTP i stderr audytu — wdrożone 2026-10-18

69 różnych testów TS w 10 plikach: 45 transport/boundary/audit/route i 24
policy/auth/double-init. Początkowe 20/41 nakładają się. HTTP ma stałe błędy,
kanoniczne kody state/entry/bridge i 409 already-initialized bez dowolnej message;
invalid-payload audit wyjątek nie trafia do Fastify response/log. Recorder stderr
ma zamknięty errno/AUDIT_WRITE_FAILED bez message/cause/action/path.
Recorder nadal jest best-effort i zwykłe I/O przechwytuje; test transportu wymusza
nieoczekiwany wyjątek zależności, a nie rzeczywiste propagowanie append failure.
Wszystkie wartości testowe są syntetyczne. Lint import-order poprawiono; finalne
lint/format/diff i strict TS build przeszły. Wdrożono 2 JS, bez native.
Dwa starty healthy, invalid0; doctor47/13/0/requiredFailures0, TUI OK, NRestarts0.
MiniMax HTTP200 i dokładny MEMPHIS_S1_7_HTTP_AUDIT_OK. Chronione pliki i indeks
sprzed wdrożenia zachowane po canary. Dowody/rollback: `/home/memphis/.memphis-backup-s1-vault-http-zcnc_r3w`.
Bez commita/push. Cofać HTTP/audit przed H3/wallet/audit/aliasami/cache.

## S1.7: H3 — wdrożone 2026-10-18

H3 zwraca wyłącznie publiczne task_id/status/HTTPS URL; zgodne pole data zawiera
te same metadane, bez dowolnego provider body. Stałe kody błędów bez wyjątków,
odrzucane redirecty, URL userinfo/non-HTTPS i znane echo klucza (raw/kodowania/
SHA-256/wybrane fragmenty16). Ochrona ograniczona, nie dowód na każde kodowanie.
Dedykowany video key zachowany, bez fallbacku chat. Nie wysłano płatnego H3 request.
33 różne testy TS: 21 H3 + 12 registry; wcześniejsze 29 nakłada się na wynik.
Typecheck/build TS, lint/format/diff przeszły. Wdrożono jeden H3 JS, bez native.
Dwa starty healthy, invalid=0; doctor47/13/0/requiredFailures0, TUI OK, NRestarts0,
MiniMax chat HTTP200 i dokładny MEMPHIS_S1_7_H3_OK. Chronione hashe i indeks
sprzed wdrożenia zachowane także po canary. Dowody/rollback: `/home/memphis/.memphis-backup-s1-h3-gdz4mucv`.
Bez commita/push. Cofać H3 przed wallet/audit/aliasami/cache.

Dalej: HTTP vault catch bloki nadal zwracają dowolne error.message, jeśli
nieoczekiwany wyjątek (np. zapis audytu) ominie bezpieczny facade. Potwierdzić
sentinelem przed zmianą. Nie oznaczać pełnego S1.7 ani S1–S9 jako ukończonych.

## V02: odmowa zapisu i brak miejsca — zweryfikowane 2026-10-18

Test-only: osiem nowych przypadków na rzeczywiście szyfrowanych v2 fixture obejmuje
pepper/master-key, pierwszy/drugi publikowany plik, symulowany ENOSPC po częściowym
zapisie tymczasowym oraz rzeczywisty EACCES na katalogu 0500 użytkownika bez root.
Każdy przypadek odzyskują dwa świeże procesy z niezależnym odszyfrowaniem Node;
drugi recovery jest no-op. Nieudany cel zachowuje oryginalne bajty, tmp usunięty,
DID zachowany; przy pepper wpisy bez zmian. Nigdy nie używają operatorowego vaulta.

26 różnych testów TS: 8 nowych i 18 istniejących transakcji. Po dodaniu jawnego
skipIf dla root/Windows finalny nowy fixture ponownie 8 pass, 0 skip. Lint/format
przeszły. Chronione pliki i indeks bez zmian; bez zmiany kodu runtime/wdrożenia.
Dowody: `/home/memphis/.memphis-backup-s1-storage-faults-u3_7bipj`. Nie przypisywać temu fizycznego zapełnienia dysku, ENOSPC SQLite,
natywnych błędów I/O, dowodu fsync po utracie zasilania ani pełnego S1.
Usługa pozostaje na E18-WALLET, pełny plan otwarty. Dalej S1.4/S1.7 i V01–V04/V11.
Bez commita/push.

## S1.7: wallet — wdrożone 2026-10-18

Wallet-sign zwraca stałe komunikaty błędów bez wyjątków/cause i długości seedu;
bufory seedu/PKCS#8 zerowane w finally. Sygnatura, klucz publiczny i hash podpisywanej
wiadomości zachowują umowę; nie podpisywano rzeczywistej transakcji. Cztery nowe
regresje najpierw zawiodły, po poprawce 16 testów w dwóch plikach przeszło, w tym
niezależny wzorzec podpisu. Typecheck/build TS, lint/format/diff przeszły.
Wdrożono dokładnie mcp/tools/wallet-sign.js, bez zmiany NAPI/TUI. Dwa starty
healthy, invalid=0, doctor 47/13/0 i requiredFailures=0, TUI OK, NRestarts=0,
MiniMax HTTP 200 z dokładnym MEMPHIS_S1_7_WALLET_OK. Chronione pliki i indeks
bezpośrednio sprzed wdrożenia zachowane po canary. Dowody/rollback: `/home/memphis/.memphis-backup-s1-wallet-uc49tyxh`.
Bez commita/push. Przy rollbacku kolejność: wallet, audit, aliasy, cache.
S1.7 nadal otwarte: H3 i pełna macierz bezpiecznych wyników publicznych.

## S1.8: proza i lokalna historia — audyt 2026-10-18

Skan po redakcji: 2237 bieżących plików, 2232 blobów indeksu, 918223 linii patchy
w 1322 lokalnie osiągalnych commitach; 120 wejść binarnych pominięto. Porównano
aktywne poświadczenia dotenv, master key i oba odszyfrowane wpisy z zgodnej
prywatnej migawki, także wybrane kodowania/hash/fragmenty. Zero trafień aktywnych
kandydatów i zero trafień worktree. To ograniczony skan lokalny, nie dowód braku
każdego możliwego kodowania ani weryfikacja widoczności zdalnego repo.

Usunięto historyczny fragment hasła Synjar z bieżącego AGENTS.md; zachowano
stary indeks i historię. Po canary wallet wykonano celową, selektywną redakcję samej notatki również
w indeksie AGENTS.md. Wszystkie inne wpisy indeksu i jego wcześniejsza treść
AGENTS poza notatką zachowane; dowód selective-index-redaction.json. Raport kwietniowy deklarował rotację; Synjar nadal
niedostępny, bieżącego stanu konta nie potwierdzono. Nie rotowano aktywnych
sekretów, nie przepisywano pamięci/audytu/historii. Fałszywe trafienia listy
blokowanych poleceń i placeholdera wykluczono po sprawdzeniu klasyfikacji.
Końcowy skan po selektywnej redakcji indeksu przeszedł: zero aktywnych trafień
i zero trafień worktree/indeksu; sześć wystąpień historycznych patchy pozostało
w raporcie prywatnym. Indeks nie zmienił się podczas końcowego skanu.
S1.8 odebrane lokalnie, bez deklaracji wyczyszczenia zdalnej historii.
Bieżącego stanu konta Synjar nie deklarować jako potwierdzonego.
Raport bez wartości: docs/postmortems/2026-10-18-credential-prose-triage.md.
Prywatne dowody: `/home/memphis/.memphis-backup-s1-prose-w34xnvt2`.

## S1.7: bezpieczne błędy i audyt — częściowo wdrożone 2026-10-18

E18-AUDIT wdrożone po S1.5/S1.6. Zamknięte klasyfikacje i typy audytu,
walidacja IP, stałe błędy inicjalizacji/rotacji bez cause i bezpieczny native
ProviderRuntime Debug. Wyniki konfiguracji maskują nieznane wartości i URL
z poświadczeniami/query/fragment, także błędnie zbudowane. Reload odrzuca zmianę
peppera nawet przy allowCold; hook zwraca CONFIG_HOOK_FAILED zamiast wyjątku,
a odrzucony reload ma appliedCount=0. Pepper już był secret — wcześniejsze
podejrzenie błędnej klasyfikacji obalono; rejestru nie zmieniano.

119 różnych przypadków TS w 19 plikach i 1 test Rust przeszły. Jedna integracja
oczekiwała dawnego surowego błędu hooka; po zmianie asercji na bezpieczny kod
przeszła ponownie. Zaliczone typecheck/build TS, build TUI, lint/format/diff.
Wdrożono pięć plików JS i TUI; NAPI i format vaulta bez zmiany. Dwa starty healthy,
invalid=0, doctor 47 pass / 13 warn / 0 fail / requiredFailures=0, TUI OK,
NRestarts=0. MiniMax HTTP 200 i dokładny MEMPHIS_S1_7_AUDIT_OK. Chronione pliki
i indeks bezpośrednio sprzed wdrożenia nie zmieniły się także po canary.
Dowody i rollback: `/home/memphis/.memphis-backup-s1-audit-rfqhtiue`.
Nie wykonano commita/push. Cofać najpierw audit, potem aliasy, na końcu cache.

S1.7 pozostaje otwarte: wallet-sign ujawnia tekst dowolnego wyjątku i długość
błędnego seedu; H3 zwraca surowe błędy sieci/provider body i data. To inwentaryzacja
powierzchni, nie dowód ujawnienia aktywnego sekretu. Callback withVaultSecret jest
zaufany i może zwrócić/rzucić dane; ograniczać publiczne DTO, nie zmieniać umowy
callbacka. S1.8 wymaga osobnego audytu prozy/historii bez wypisywania wartości.
Pełne S1–S9 nadal otwarte.

## S1.6: aliasy providerów — wdrożone 2026-10-18

Wspólny fixture JSON obejmuje MiniMax, DeepSeek, GLM i Anthropic. TS i native
sprawdzają ten sam scenariusz: default/custom alias, odstępy wokół referencji,
wymianę wpisu, usunięcie, uszkodzony najnowszy wpis i jawny wybór plaintextu.
Native wcześniej szukał referencji ze spacjami i wracał do plaintextu. Teraz
normalizuje nazwę, a brak jawnie wskazanego wpisu przy obecnym plaintext daje
bezpieczny PROVIDER_CREDENTIAL_CONFLICT. Bez referencji plaintext nadal działa.
Normalizacja zachowuje blokadę użycia anthropic_oauth_refresh_token jako API key.
Naprawiono także native Anthropic is_configured=true przy brakującym kluczu.
TS rozróżnia w opisie konfliktu brak wpisu od nieudanego odczytu poświadczenia.

43 testy TS w 5 plikach i 10 testów Rust selektora przeszły. Nowe regresje najpierw
wykazały spacje/fallback i błędny opis TS; później wspólny fixture wykazał fałszywy
stan Anthropic. Początkowe logi i poison błędy po pierwszej asercji nie są wynikiem
końcowym. Build TS z typecheckiem, build TUI, lint zakresu, format i diff przeszły.
Wdrożono dokładnie providers/index.js oraz TUI, przy zatrzymanej usłudze.
NAPI i format vaulta pozostały te same co w zweryfikowanym S1.5.

Dwa starty API healthy, invalid=0; doctor 47 pass / 13 warn / 0 fail,
requiredFailures=0, TUI ok=true, service active, NRestarts=0. MiniMax HTTP 200,
providerUsed=minimax, dokładny MEMPHIS_S1_6_ALIAS_OK. Chronione hashe i indeks
bezpośrednio sprzed wdrożenia nie zmieniły się także po canary. Kopia, źródła,
patche, logi i rollback: `/home/memphis/.memphis-backup-s1-alias-l_m43f6t`.
Nie wykonano commita ani push. Przy wycofywaniu kilku przyrostów cofać najpierw
aliasy, dopiero potem cache — nie mieszać zestawów artefaktów.

S1.6 odebrane lokalnie. Dalej pozostałe S1.4, S1.7–S1.8 i odbiór całego S1.
Wstępna inspekcja S1.7: ProviderRuntime Debug zawiera api_key; publiczna
initializeVault propaguje dowolny tekst błędu/cause; CLI master-key-rotate zapisuje
err.message do audytu. Ustalić stałe bezpieczne wyniki i dodać sentinele przed
jakąkolwiek deklaracją zamknięcia S1.7. Nie oznacza to potwierdzenia ujawnienia
aktywnego sekretu; testy dotąd używały wyłącznie syntetycznych poświadczeń.

## S1.4/S1.5: cache i odzyskiwanie metadanych — wdrożone 2026-10-18

Operator doprecyzował: „dopnij plan” oznacza wykonanie S1–S9 z potrzebnymi
pivotami, nie samo uporządkowanie dokumentacji. Kontynuować implementację.

TS usuwa i zeruje stary klucz po zmianie tożsamości/generacji i błędzie odczytu;
zaakceptowany reload czyści cache natychmiast, no-op/dry-run/odmowa go zachowują.
Rust przechowuje jedną generację, używa SHA-256 zamiast FNV i zeruje klucz przy
Drop. Native odczytuje wejścia pod blokadą, wykonuje KDF poza nią, ponownie
sprawdza tożsamość i dopiero wybiera/odszyfrowuje wpis pod blokadą. Odpowiada to
kontraktowi TS i usuwa timeout blokady ujawniony przez dwa ciepłe czytniki.
Lista, latest, metadane i boot odzyskują journal przed sprawdzeniem pustego vaulta.

Decyzja S1.5 w ARCHITECTURE: generacja konfiguracji jest lokalnym epoch; zgodność
między procesami opiera się na zapisanych plikach i tożsamości stanu, nie równości
liczników. Pepper jest cold: stary proces po zewnętrznej rotacji zwraca bezpieczny
błąd, świeży ładuje zgodny dotenv. Bez trzeciego pliku licznika i cichego
nadpisywania jawnego env. Formatów, kluczy i aktywnych sekretów nie zmieniano.

99 różnych testów TS w 16 plikach zaliczonych: 23 lifecycle/config, 69 powierzchni
(68 w pierwszym przebiegu + jeden timeout powtórzony osobno), 7 snapshot/races.
187 różnych testów Rust zaliczonych: 51 vault, 135 operator w pełnym przebiegu
oraz 1 dodatkowy test wymiany/usunięcia wpisu bez ponownego KDF. Jeden test BASAL
pominięty. Nie jest to cały suite TS ani workspace Rust. Typecheck, build TS,
build NAPI/TUI, lint zakresu, Prettier, rustfmt i diff --check przeszły.

Pierwsze regresje wykazały brak zerowania/ewikcji i ignorowanie epoch w TS oraz
zachowywanie starych generacji w Rust — poprawione. Kolejny test wykazał native
KDF pod blokadą — poprawione. Fixture fresh-process przekazywał stary jawny
pepper — poprawione przez brak nadpisania przy nowym odczycie dotenv. Równoległe
KDF przeciążyły host; pojedynczy timeout state parity i procesowy timeout
powtórzone kolejno przeszły. Logi początkowych niepowodzeń pozostają dowodem
przebiegu, nie wynikiem końcowym. Test kilku niecache'owanych KDF adaptera ma 90 s.

Wdrożono przy zatrzymanej usłudze dokładnie 3 pliki dist: hot-reload,
rust-vault-adapter, vault-entry-store oraz NAPI i TUI. Testowany NAPI jest bajtowo
zgodny z finalnym buildem; ostatni test nie zmienił binarki TUI. Pierwszy i drugi
start: API healthy, integrity invalid=0. Po drugim doctor 46 pass / 14 warn /
0 fail, requiredFailures=0; TUI ok=true; service active, NRestarts=0. Różnica
jednego ostrzeżenia wobec 17-go to opcjonalny GLM connectivity. MiniMax HTTP 200,
providerUsed=minimax, dokładny MEMPHIS_S1_5_CACHE_OK. Hashe .env, state/entries
vaulta i DID po canary bez zmian. Nie wykonano commita ani push.

Dowody, źródła, patch, chroniona kopia i rollback:
`/home/memphis/.memphis-backup-s1-cache-hhvr3j_t`. `deploy.py --rollback` odtwarza
cały zgodny zestaw artefaktów. `verification-final.json` dokumentuje wynik.
W trakcie pracy wykryto zmianę indeksu względem kopii z 17-go; agent nie wykonał
git add/reset/commit. Zachowano obie kopie oraz listę różnic. Nie przywracać
starego indeksu zbiorczo. Indeks bezpośrednio sprzed wdrożenia pozostał bajtowo
niezmieniony także po canary. Synjar nadal niedostępny.

S1.5 odebrane w tym kontrakcie. Całe S1 i wydanie S1–S9 pozostają otwarte.
Historyczny następny brak S1.6 (następnie naprawiony powyżej): native dopuszczał
plaintext fallback po braku jawnej referencji. Kopia początkowa:
`/home/memphis/.memphis-backup-s1-alias-l_m43f6t`.

## S1.4: spójny odczyt poświadczenia podczas rotacji — 2026-10-17

Wdrożono kolejny zakres S1.4. `readLatestVaultSecret` odzyskuje dziennik przed
wyborem wpisu, ładuje klucz poza blokadą, a następnie pod wspólną blokadą
sprawdza generację stanu i ponownie wybiera oraz odszyfrowuje wpis. Zmiana
stanu wymusza ponowienie zamiast łączenia starego wpisu z nowym kluczem.
`readVaultSecretByKey`, `withVaultSecret` i startowy probe korzystają z tej
ścieżki. Callback użytkownika wykonuje się po zwolnieniu blokad. Fasada nie
powtarza już sprawdzenia fingerprintu sekretu w TS; korzysta z dekodera Rust.
Dotychczasowe komunikaty błędów pozostają, wynik odczytu dodaje bezpieczny
`errorCode`; błędny JSON również zwraca kontrolowany błąd bez wejściowej treści.

76 różnych testów TS w 9 plikach zaliczonych: 70 w zestawie powierzchni,
powtórzony pojedynczy przypadek auth oraz 5 testów procesowych. Dwa nowe
scenariusze zatrzymują odczyt zwykły/bounded-use po dekodowaniu starego stanu,
kończą rotację master key w innym procesie, a następnie sprawdzają poprawny
odczyt, cache i nowy proces. Zgodność błędów TS/native obejmuje stan, wpisy,
fingerprint, ciphertext i UTF-8. Całego suite ani testów Rust nie uruchamiano;
natywne źródła i artefakty pozostają bez zmian.

Początkowo mock testu miał błąd hoistingu — poprawiony przez `vi.hoisted`.
Pierwsze testy procesowe przekroczyły 30 s przy kosztownej inicjalizacji,
przed asercjami wyścigów. Zestaw writer/read używa teraz syntetycznego stanu
początkowego i prawdziwej kryptografii Rust; osobne testy inicjalizacji zachowują
tryb `init`. Tryb fixture `seed` odmawia przed importem konfiguracji poza
NODE_ENV=test i izolowanymi ścieżkami. Sprawdzono dozwolony seed oraz odmowę
production bez zmiany fixture. Rozszerzony test błędnego peppera wykonuje kilka
niecache'owanych KDF: jego limit zmieniono z 30 na 90 s; powtórka przeszła
w 24.29 s łącznie. Zapisane pierwsze niepowodzenia nie są wynikami końcowymi.

Typecheck, kompilacja TS, lint zmienionego zakresu, format i diff --check
przeszły. Build różnił się od działającej instalacji dokładnie trzema plikami:
`rust-vault-adapter.js`, `vault-entry-store.js`, `security/vault-boundary.js`.
Wymieniono je przy zatrzymanej usłudze; kopia i automatyczny rollback gotowe.
Oba kontrolowane starty: API healthy; po drugim doctor 47 pass / 13 warn /
0 fail, requiredFailures=0; native TUI ok=true; service active, NRestarts=0.
MiniMax po drugim starcie: HTTP 200, providerUsed=minimax, dokładny znacznik
MEMPHIS_S1_4_SNAPSHOT_OK. Po canary hashe .env, vault state/entries i DID oraz
oryginalny indeks Git nadal bez zmian. Nie wykonano commita ani push.

Dowody, wybrany patch, źródła początkowe, poprzednie trzy artefakty i skrypty:
`/home/memphis/.memphis-backup-credential-snapshot-vfpr6y2u`.
Pełnego S1 nie zamykać. Dalej odbiór pozostałych ścieżek S1.4 oraz S1.5:
cache i generacje konfiguracji, w tym zmiana peppera w długowiecznych procesach.

## Commit i GitHub — 2026-10-17

Na późniejsze polecenie operatora zapisano zakres vault/config/readers w commicie
`10fac3d81901892001d8634c754e42a333659fca`
(`refactor(vault): share persisted readers across TypeScript and Rust`).
Wysłano go przez aktywny PAT w keyringu gh, konto `elathoxu-crypto`, do
`elathoxu-crypto/memphis-fork`, gałąź `fix/embed-persistence-and-chain-parse`.
To uzupełnia wcześniejsze historyczne adnotacje „bez commita/push”.

Commit obejmuje 48 plików. Z dwóch współdzielonych plików Rust wybrano tylko
hunk vaulta; wcześniejsze zmiany embed pozostały lokalnie. Pozostałe wpisy
indeksu zachowano i porównano po commicie. Nie commitowano zbiorczo innych
zmian projektu. Izolowany snapshot commita przeszedł TypeScript --noEmit
oraz cargo check operator/NAPI. Hook pre-commit wykonał pełny lint; pięć
wcześniejszych ostrzeżeń, bez błędów. Wychodzące patche sprawdzono pod kątem
aktywnych sekretów bez wypisywania ich wartości. Kopia indeksu, wybrany patch
i logi: `/home/memphis/.memphis-backup-git-publish-54oe1h3h`.
Nie wykonano merge do main ani utworzenia PR; usługi nie restartowano.

## S1.4: wspólny czytnik wpisów — wdrożenie 2026-10-17

Wdrożono lokalnie. `memphis-vault::entries` wspólnie
parsuje istniejący JSON, wybiera ostatni dopisany wpis dla klucza, sprawdza
fingerprint i dekoduje ciphertext/nonce/tag. TS korzysta z nowych eksportów
NAPI `vault_parse_entries` i `vault_decode_entry`; operator natywny używa tego
samego modułu. Nie ma fallbacku do starszego wpisu po błędzie najnowszego.
Fingerprint używa serializatora JSON zamiast ręcznego składania tekstu, więc
klucze z cudzysłowem, backslashem, znakami sterującymi i Unicode są zgodne z TS.
Zachowane są legacy combined-tag, brak historycznych metadanych i dodatkowe
pola JSON przy zapisie/usuwaniu innych wpisów. Tekst jest walidowany jako UTF-8;
BOM w poświadczeniu pozostaje częścią wartości.

Błędy mają stałe kody bez wejściowych danych: `VAULT_ENTRIES_UNREADABLE`,
`VAULT_ENTRIES_MALFORMED`, `VAULT_ENTRY_NOT_FOUND`, `VAULT_ENTRY_INTEGRITY_FAILED`,
`VAULT_ENTRY_AUTH_FAILED`, `VAULT_ENTRY_INVALID_TEXT`. Brak pliku lub poprawne
`[]` oznacza brak wpisów. Istniejący pusty/uszkodzony plik nie jest pustym
vaultem — również podczas rotacji klucza głównego. Testy sprawdzają odmowę
rotacji bez zmiany stanu i wpisów. Nie zmieniono formatu writerów ani kluczy.

Kopia punktu wyjścia, indeksu, artefaktów oraz logi:
`/home/memphis/.memphis-backup-vault-entries-nvy1yvan`.
Prywatny target Cargo pozostaje w
`/home/memphis/.memphis-backup-journal-contract-b4_xrqby/target-next`.
Most testowy wybiera `MEMPHIS_TEST_NATIVE_BRIDGE`; dane są izolowane.
Końcowo 164 różne testy TS w 24 plikach przeszły w trybie strict, uruchamiane
w grupach: kontrakt/adapter 46; rotacje/migracje 25, następnie końcowy zestaw
rotacji/korupcji 16 (zastępuje wcześniejsze 6 testów master-key); CLI/API 40;
współbieżność/migracja journalu 12; awarie/ochrona inicjalizacji 31. Sześć
scenariuszy SIGKILL sprawdza każdy etap rotacji peppera/master-key, odzyskanie
i ponowny odczyt w nowym procesie. Nie uruchamiano całego suite TS.

Pierwsze CLI/API: 38/40; dwie awarie wyłącznie w mocku CLI apps. Częściowy mock
zachowuje realny parser, a jego szyfrowane wpisy używają właściwych pól
`encrypted`/`iv`; końcowo cały ten plik 16/16. Fixture guards wskazuje prywatny
most. Rust entries: 4/4. Operator: 130 pass, 1 fail, 1 ignored, następnie
jedyny błąd (asercja starego komunikatu) poprawiony i test przeszedł. Łącznie
131 różnych testów operatora zaliczonych, jeden wymagający BASAL pominięty.

Build NAPI/TUI, fixture oraz końcowy build TS przeszły. Testowany NAPI jest
bajtowo identyczny z końcowym artefaktem. Pełny lint wskazał jedną kolejność
importów i 5 wcześniejszych ostrzeżeń; import poprawiono, końcowy lint tego
zakresu przeszedł. Prettier, rustfmt nowych modułów i diff --check przeszły.
Zastane artefakty zgadzały się z kopią początkową. Podczas wdrożenia wymieniono
trzy pliki dist (rust-vault-adapter, vault-entry-store, rust-bridge-manifest),
NAPI i TUI. Usługę zatrzymano na wymianę, po starcie API healthy. Automatyczny
rollback nie był potrzebny; stary dist jest w `dist-replaced`, poprzednie
binarki w `predeploy-*` katalogu kopii. Nie używać starego NAPI z nowym TS —
manifest wymaga nowych eksportów.

Kontrole po wdrożeniu, wykonywane kolejno: doctor 47 pass / 13 warn / 0 fail,
requiredFailures=0; natywne TUI OK; chain verify 421 bloków / 9 łańcuchów / OK;
service active, NRestarts=0. Hashe .env, stanu i wpisów vaulta oraz DID bez zmian.
Dowody: `verification-deployed.json`, `*-deployed.json` i prywatne logi testów.
MiniMax: HTTP 200, providerUsed=minimax, dokładny znacznik MEMPHIS_S1_4_ENTRIES_OK
(temperature=0.7). Po tej próbie ponownie potwierdzono niezmienione hashe
chronionych danych. Nie wykonano rebootu hosta.

Nie zamykać całego S1.4 na tej podstawie: publiczna fasada TS nadal adaptuje
błędy do historycznych wyników i samodzielnie sprawdza metadata integrity;
pełna granica wyboru/odczytu/klasyfikacji wymaga dalszego odbioru. S1.5 i dalsze
punkty również pozostają otwarte. Nie wykonano commita ani push.

## S1.4: wspólny czytnik stanu vaulta — 2026-10-16

`memphis-vault::state` jest teraz wspólnym czytnikiem istniejących formatów v1/v2.
Native operator i TS przez nowe NAPI `vault_load_state` używają tej samej
walidacji, scrypt i AES-GCM. Usunięto dwa niezależne dekodery. Writer v2,
parametry kryptograficzne i transakcje rotacji pozostają zgodne z wcześniejszym
formatem; nie rotowano aktywnych kluczy.

Czytnik zwraca bezpieczne kody: `VAULT_STATE_MISSING`, `VAULT_STATE_UNREADABLE`,
`VAULT_STATE_MALFORMED`, `VAULT_STATE_UNSUPPORTED_VERSION`, `VAULT_PEPPER_REQUIRED`,
`VAULT_STATE_AUTH_FAILED`. Nie wypisuje wejściowego JSON ani peppera. Walidacja
32/32/12/16 bajtów wyprzedza kryptografię i usuwa możliwość panic na błędnym IV.
Jawna ścieżka stanu w native nie przechodzi już na inny vault po braku pliku.
Opcjonalny provider traktuje jako brak vaulta tylko brak stanu bez pliku wpisów;
uszkodzenie lub nieczytelność pozostaje błędem. TS zachowuje odczyt v1 i migrację
v1→v2 przy dostępnym pepperze. Minimalna długość peppera w Rust odpowiada
jednostkom UTF-16 JavaScript, również dla znaków spoza BMP. Zestaw znaków
usuwanych z końców peppera odpowiada JS, również dla BOM i NEL.

NAPI i TS trzeba wdrażać razem: manifest wymaga teraz `vault_load_state`.
Testy pozwalają wskazać osobny artefakt przez `MEMPHIS_TEST_NATIVE_BRIDGE`,
nie zmieniając izolacji ścieżek danych. Mocki szyfrowania wpisów delegują odczyt
stanu do prawdziwego Rust. Naprawiono przygotowanie fixture HTTP oraz fixture
`ask`, które wcześniej pomijało wymagany first-run; nie osłabiono bramki startu.

To zamyka wspólny odczyt/dekodowanie stanu w S1.4, nie pełny odbiór S1.
Pozostaje wspólna fasada wyboru wpisów i klasyfikacji błędów wpisów, następnie
S1.5 (cache), S1.6 (aliasy), S1.7 (bezpieczne diagnostyki), S1.8 (historyczne treści).
Odczyt TS sprawdza identyfikator pod wspólną blokadą przed dekodowaniem i po
nim, przed aktualizacją cache. Zmiana stanu powoduje wyczyszczenie odczytanego
klucza i ponowienie (maksymalnie trzy próby). Usuwa to wyścig, w którym stary
klucz mógł dostać hash nowego pliku po równoległej rotacji. KDF poza blokadą
nie blokuje innych procesów; wcześniejszy wariant z KDF pod blokadą ujawnił
SQLITE_BUSY w teście trzech writerów i został zastąpiony. Snapshot wewnątrz
writera może użyć już trzymanych blokad, ale nie rozszerzyć zestawu. Transparentna
migracja v1 również odbywa się pod blokadą. Rotacja master key czyta v1 bez
osobnej migracji i publikuje v2 w swojej transakcji, zachowując expected hash.

Prywatne kopie indeksu/worktree, poprzednich artefaktów i logi:
`/home/memphis/.memphis-backup-vault-state-tddu6g5u`.
Synjar podczas rozpoczęcia pracy był niedostępny (localhost:6200 connection refused).

Końcowa weryfikacja 2026-10-17: 56 testów TS w 7 plikach przeszło
(`ts-deploy.log`), osobno 3 testy współbieżnych writerów (`ts-snapshot-retry.log`).
Obejmuje zgodność TS/NAPI/native, v1/v2, błędy bez danych wejściowych,
rotację v1, snapshoty, sześć SIGKILL rotacji i ponowne odczyty po odzyskaniu.
Nowa regresja zatrzymuje czytnik po dekodowaniu, kończy rotację w drugim
procesie, po czym sprawdza ponowiony odczyt i poprawny zapis z nowym kluczem.
Wcześniejsze 40 testów powierzchni CLI/HTTP/onboarding/izolacji przeszło
po poprawkach fixture. Nie oznacza to pełnego uruchomienia całego test suite.

Rust: wcześniej pełne memphis-vault (42), memphis-operator (130 unit + 1
integration; test wymagający BASAL pominięty); po zmianach dodatkowe 5 testów
czytnika i 1 opcjonalnego odczytu przeszło. Końcowe 5 testów czytnika uwzględnia
BOM/NEL. Build NAPI, TUI, natywnego fixture i TS przeszedł. Pełny lint:
0 błędów, 5 ostrzeżeń; końcowy lint zmienionego zakresu bez ostrzeżeń kodu.
Rustfmt i git diff --check przeszły. Zestaw TS z KDF pod blokadą miał
SQLITE_BUSY; ten wariant nie jest wersją końcową. Uruchomienia testów równolegle
z pełnym lintem/buildem miały też timeouty; końcowe próby wykonano kolejno.

Końcowy build zmienia trzy pliki dist: config-transaction, rust-vault-adapter
i rust-bridge-manifest. Dodatkowo wdrażane są NAPI i TUI. Zastane binarki
zmieniły się podczas długiej sesji: NAPI odpowiadało wcześniejszemu testowemu
artefaktowi; zachowano je osobno jako `predeploy-index.node` i
`predeploy-memphis-tui`, bez nadpisania pierwotnych kopii. Dist i chronione
pliki danych pozostały zgodne z kopią początkową.

Wdrożenie 2026-10-17: wymieniono trzy pliki kompilowane TS, NAPI i TUI po
zatrzymaniu usługi. Automatyczny rollback nie był potrzebny. API healthy,
systemd active, NRestarts=0; natywne TUI check-only OK, bez błędów snapshotu.
Chain verify: 382 bloki, 9 łańcuchów, OK. Pierwszy doctor: 44 pass / 16 warn /
0 fail (requiredFailures=0); równoległy probe vaulta zwrócił ostrzeżenie,
ale późniejszy osobny cykl encrypt/decrypt przeszedł. Pierwsze żądanie MiniMax
z temperature=0 zakończyło się błędem fallbacku do brakującego modelu Ollamy
qwen2.5-coder:3b. Powtórzenie z temperature=0.7: HTTP 200, providerUsed=minimax,
dokładny oczekiwany znacznik. Nie ustalono bezpośredniego błędu pierwotnego
żądania; nie przypisywać go uszkodzeniu vaulta. Chronione hashe .env, stanu,
wpisów vaulta i DID bez zmian. Dowody w katalogu kopii, `*-deployed*` oraz
`verification-final.json`; poprzedni dist w `dist-replaced`.
Nie wykonano commita ani push w tej sesji. S1.4 jako całość pozostaje otwarte.
Końcowy doctor uruchomiony osobno: 47 pass / 13 warn / 0 fail,
requiredFailures=0, cipher-cycle pass (`doctor-deployed-recheck.json`).

## PAT i przegląd wyników Memphisa — 2026-10-17

Na prośbę operatora sprawdzono aktywne uwierzytelnienie przez GitHub API:
PAT działa jako `elathoxu-crypto`, classic, wygaśnięcie
2027-01-13 19:25:18 UTC. `gh auth status` potwierdza keyring; brak tokena w
hosts.yml (0600) i brak nadpisania przez GH_TOKEN/GITHUB_TOKEN. Nie zapisano
ani nie wypisano wartości tokena. Zakresy pozostają szerokie, m.in. repo,
workflow, delete_repo, admin:org i admin:enterprise; nie zmieniano ich.

API potwierdza: Memphis-Chains/memphis — pull, bez push; własny
elathoxu-crypto/memphis-fork — fork tego upstreamu, push i admin;
elathoxu-crypto/memphis — oddzielne repo, ostatni push 2026-03-07.
Remote fork jest skonfigurowany. Aktualny main upstreamu i lokalne origin/main
to 942687e7; nasza gałąź ma 6 własnych commitów i brakuje jej 9 z main.
Na forku nie ma gałęzi fix/embed-persistence-and-chain-parse. W lokalnym
statusie jest 140 pozycji zmian, w tym mieszana praca z wcześniejszych sesji;
nie przypisywać całego zestawu jednemu agentowi.

Przeczytano `.claude/handoff-2026-10-16-evening.md`. Potwierdzono istnienie
transkryptów, forka i wskazanych uproszczeń starego kodu w /tmp/elath-memphis
(delegated→weighted, pierwszy agent jako lider Raft, puste automatyczne
monitorowanie procesów, ograniczenie inferred confidence do 0.85).
Dwie korekty do raportu:

- Test `src/intelligence/__tests__/event-detector.test.ts` zawiera rzeczywiste
  testy i asercje, nie tylko puste importy. Nie uruchamiano starego suite.
- PR z własnego forka do publicznego upstreamu nie wymaga upstream write;
  potrzebny jest zapis do gałęzi źródłowej, który mamy. Reguła potwierdzona
  w https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request.
  Pomiar stałego RSS opisany przez Memphisa nie jest dowodem ogólnego braku
  wycieków pamięci; nie powtarzano tego eksperymentu.

## Inicjalizacja vaulta — najnowszy wynik 2026-10-15

Commit `0863ec21` wdrożony. Inicjalizacja trzyma blokadę dziennika od
odzyskania transakcji i sprawdzenia danych, przez generowanie klucza, do
atomowego zapisu stanu. Odtworzono wcześniejszy wyścig dwóch procesów:
obie inicjalizacje mogły zgłosić sukces z różnymi kluczami. Teraz druga
odmawia, a sekret pierwszej daje się odszyfrować w nowym procesie.
SIGKILL przed publikacją nie blokuje późniejszej poprawnej inicjalizacji.
Niepoprawny/nieczytelny stan oraz osierocone lub uszkodzone wpisy nie są
traktowane jako pusty vault. Jawna flaga force nadal omija kontrolę danych,
ale nie blokadę.

114 testów w 19 plikach przeszło w trybie strict, w tym regresje rotacji,
współbieżnych zapisów i odczytów TS/Rust. Typecheck, build TS i formatowanie
przeszły; pełny lint: 0 błędów, 3 ostrzeżenia. Rust i natywne binarki bez zmian.
Porównanie buildów: zmienił się wyłącznie `infra/storage/rust-vault-adapter.js`.
Po restarcie: API healthy, 79 bloków / 0 błędów, NRestarts=0; MiniMax HTTP 200
z oczekiwanym znacznikiem; TUI preflight OK, bez błędów snapshotu. Doctor:
46 pass / 14 warn / 0 fail. Dodatkowe ostrzeżenie względem poprzedniego pomiaru
to opcjonalne `t3-query-latency`: 1.995 ms przy progu 1 ms.
Hashe env, vaulta i DID pozostały bez zmian. Wcześniejszy indeks Git zachowany;
commit zawiera tylko ten zakres. Nie wykonano push.

Dowody, kopia indeksu/worktree i poprzedni dist:
`/home/memphis/.memphis-backup-vault-init-dwh11_25`.
Szczegóły: [opis inicjalizacji](../docs/postmortems/2026-10-15-vault-init-serialization.md).

Dalej S1: wspólny kontrakt konfiguracji i wyboru dziennika dla samodzielnego
TS/native, z zachowaniem odzyskiwania historycznych dzienników. Obecna blokada
koordynuje procesy używające tej samej ścieżki dziennika; nie rozwiązuje
rozbieżnych rootów ani dzienników. Sama zamiana fallbacku może ominąć wcześniej
przygotowaną transakcję — wymaga testów migracji/odzyskiwania. Pełny odbiór
S1.1–S1.8 nadal pozostaje do wykonania.

## S1.1: cykl życia serwera — 2026-10-16

Kontynuacja po doprecyzowaniu operatora „chce zebys dokodowal co miales”.
Bootstrap przypina i zamraża snapshot przed tworzeniem usług oraz przekazuje
absolutne ścieżki przez środowisko. Udany reload zmienia generację procesu;
dry-run, brak zmian i odrzucony plan pozostawiają ją bez zmian. Ścieżki i
metadane generacji są restart-bound. Równoważny względny zapis ścieżki w dotenv
nie blokuje reloadu. Jawny runtime root kotwiczy względne ścieżki vaulta również
bez package.json. Generacja opisuje przyjęty swap środowiska, nie potwierdzenie
odświeżenia wszystkich cache; pozostaje lokalna dla procesu.

30 testów w 6 plikach przeszło, w tym integracja zmiany providera, lifecycle
reloadu, launcher i service. Lint: 0 błędów, 1 ostrzeżenie dostępu do process.env.
Prywatna kopia źródeł i dist sprzed zmian:
`/home/memphis/.memphis-backup-snapshot-rmdrwem0`.

Build TypeScript i wcześniejszy typecheck przeszły; końcowy build zawiera także
poprawkę względnych ścieżek. Wdrożono po zatrzymaniu usługi, z zachowaniem
poprzedniego dist. Po starcie: API healthy, active, NRestarts=0, native TUI
check-only ok, doctor 46 pass / 14 warn / 0 fail (requiredFailures=0).
Hashe .env, vault-state, vault-entries i DID bez zmian. S1.1 oznaczono wykonane;
pełny odbiór S1 pozostaje otwarty, następne są S1.4–S1.8. Nie wykonano
commita ani push. Ta sekcja zastępuje wcześniejszą informację o brakującym
przypięciu snapshotu w cyklu życia serwera.

## S1.1/S1.2: snapshot ścieżek i ochrona peppera — 2026-10-16

S1.3 jest również odebrane na fixture: istniejący test rotacji przerwał
SIGKILL przed publikacją i po każdym z dwóch zapisów dla rotacji peppera
i master key, po czym nowy proces odszyfrował komplet wpisów i przeszedł
powtórny start. Te sześć przypadków przeszło w regresji 45 testów TS.

S1.2: ogólne `config set`/unset odmawia zmiany peppera zainicjalizowanego
vaulta. Kontrolę przeniesiono pod blokady dzienników vault-state i dotenv,
więc nie przegrywa wyścigu z równoległą inicjalizacją. Intencjonalna zmiana
pozostaje w operacji rotacji.

S1.1: dodano typowany snapshot ścieżek z pochodzeniem oraz generacją procesu;
CLI service rozstrzyga runtime root przez ten kontrakt, launcher CLI przekazuje
TUI/native te same absolutne ścieżki i źródła, a `OperatorConfig` zachowuje
metadane i kotwiczy ścieżki względne w runtime root. To postęp, nie pełne
zamknięcie S1.1: serwerowy cykl życia konfiguracji nie przypina jeszcze
snapshotu generacji przy starcie i zmianie konfiguracji.

Typecheck, lint zmienionych plików, formatowanie, 41 testów TS oraz Rust operator
(130 pass, 1 zewnętrzny BASAL ignored + test hash-chain pass) przeszły. Build
TS oraz NAPI/TUI w prywatnym target-dir przeszedł. Po wdrożeniu API healthy,
`NRestarts=0`, native TUI check-only `ok: true`, chain verify pass, doctor
47 pass / 13 warn / 0 fail. Hashe `.env`, vault state/entries i DID bez zmian.
Kopie poprzednich artefaktów, logi i raporty są w prywatnym katalogu
`/home/memphis/.memphis-backup-journal-contract-b4_xrqby`. Nie wykonano commita
ani push; zachować mieszany indeks.

## S1: wspólny wybór dziennika — 2026-10-16

Przygotowano i wdrożono zmianę wyboru dziennika transakcji między TS i native.
Nowe transakcje zapisują zamiar w dzienniku vault-state; przy jawnym `.env`
lub `MEMPHIS_RUNTIME_ROOT` obie powierzchnie blokują i sprawdzają również
historyczny dziennik `.env.transactions`. Alias ścieżek jest deduplikowany,
blokady pobierane w stabilnej kolejności, a odzyskiwanie odmawia zgadywania,
gdy niedokończone zamiary są jednocześnie w obu dziennikach. Dodano regresje
TS/Rust i odtworzenie odzyskiwania rotacji z historycznego dziennika.

Wyniki: typecheck; 45 testów TS w 8 plikach, w tym wieloprocesowe/SIGKILL;
`cargo test -p memphis-operator`: 130 pass, 1 test wymagający BASAL ignored,
plus test integracyjny hash-chain pass. Pełny lint: 0 błędów, 4 ostrzeżenia.
`npm run build` przeszedł. Po wdrożeniu API healthy, `NRestarts=0`, chain verify
pass, doctor 47 pass / 13 warn / 0 fail. TUI interaktywny check nie był
wykonywany: w tym środowisku brak TTY; uruchomienie `--help` wymagało
operator passphrase i zostało przerwane. Hashe `.env`, vault state/entries i DID
bez zmian. Nie wykonano commita ani push.

Kopia poprzedniego `dist`, NAPI, TUI, logi testów i doctor przed/po znajdują się
w prywatnym katalogu `/home/memphis/.memphis-backup-journal-contract-b4_xrqby`.
Zakres S1.1–S1.8 nadal nie ma pełnego odbioru.

## Odczyt native — poprzedni wynik 2026-10-15

Commit `67541c0e` wdrożony: Rust blokuje wspólny dziennik przez cały odczyt
stanu i wpisów (sekret, provider/cache, podsumowanie). Niedokończona transakcja
zwraca potrzebę odzyskania zamiast próby odszyfrowania mieszanych plików.
Launcher przekazuje native dokładną ścieżkę dotenv; native obsługuje też
historyczny dziennik pod ścieżką stanu. Samodzielny native korzystający z dotenv
musi mieć MEMPHIS_ENV_FILE albo MEMPHIS_RUNTIME_ROOT. Nie zgaduje obcego .env.

447 testów Rust przeszło, 2 pominięte. Dwa testy procesów TS/Rust oraz sześć
testów launchera przeszły; launcher powtórzony po dodaniu asercji ścieżki env.
Build Rust/TS oraz pełny lint przeszły (lint: 3 ostrzeżenia). Po wdrożeniu:
API healthy, 79 bloków / 0 błędów, NRestarts=0, MiniMax HTTP 200 z oczekiwanym
znacznikiem, nowy TUI preflight OK, doctor 47 pass / 13 warn / 0 fail.
Env, vault i DID bez zmian. Wcześniej otwartych interaktywnych TUI nie zamykano;
korzystają z nowej binarki przy następnym uruchomieniu.

Dowody, poprzedni dist i natywna binarka:
`/home/memphis/.memphis-backup-native-vault-kr32jwxf`.
Commit wycięto z osobnego indeksu: wcześniejsze zmiany metadanych pamięci oraz
opcji launchera pozostały staged i nie weszły do tego commita.

Dalej S1: wspólny kontrakt wyboru konfiguracji/journalu dla samodzielnych
uruchomień, ochrona współbieżnej inicjalizacji oraz pełny odbiór pozostałych
punktów S1.1–S1.8. Native sygnalizuje pending recovery; odtwarzanie wykonuje
istniejący loader TS. Całe S1 nadal nie ma pełnego odbioru.

## Współbieżne zapisy — poprzedni wynik 2026-10-15

Commit `0cb8869d`. Pełny lint: 0 błędów, 3 ostrzeżenia. Pozostały indeks Git zachowany.

Odtworzono błąd dwóch procesów: wpis zaszyfrowany przed rotacją mógł zostać
przyjęty po zmianie klucza. Poprawka blokuje taki zapis przed zmianą pliku;
ponowne szyfrowanie w tym samym procesie działa, potwierdzając odświeżenie cache.
Zapis i usuwanie wpisów korzystają ze wspólnej blokady dziennika i atomowej
publikacji. Uszkodzony JSON nie jest już traktowany jako pusta lista przy mutacji.

108 testów w 17 plikach przeszło, w tym trzy równoległe procesy zapisujące
12 wpisów oraz wcześniejsze scenariusze SIGKILL. Build przeszedł i został
wdrożony. Po restarcie: API healthy, 79 bloków / 0 błędów, NRestarts=0,
MiniMax HTTP 200 z oczekiwaną odpowiedzią, TUI OK, doctor 47 pass / 13 warn /
0 fail. Env, vault i DID mają niezmienione hashe.
Dowody, poprzedni build i kopia indeksu:
`/home/memphis/.memphis-backup-vault-writers-f67y4vlk`.

Następny krok S1: spójny odczyt pary stan/wpisy w native podczas rotacji oraz
jednoznaczny wybór konfiguracji/journalu między powierzchniami. Blokada chroni
procesy używające tej samej ścieżki dziennika; nie obejmuje zewnętrznych edytorów
ani konkurencyjnej inicjalizacji. Całe S1 pozostaje nieodebrane.

## Rotacja i wdrożenie — poprzedni wynik 2026-10-15

Commit `3501e68d` integruje odzyskiwanie rotacji peppera i klucza głównego,
loader konfiguracji oraz ścieżkę CLI. Sześć testów awarii przez SIGKILL używa
rzeczywistego Rust/NAPI i sztucznych zaszyfrowanych wpisów. Każdy przypadek
odzyskuje transakcję w nowym procesie, odszyfrowuje wszystkie wpisy i przechodzi
kolejny start. Testowany jest też stary pepper odziedziczony przez proces.
Dodatkowo 52 testy regresji vaulta/CLI/konfiguracji przeszły. Build TS i pełny
lint przeszły (lint: 3 ostrzeżenia, 0 błędów).

Wdrożono zbudowany `dist`, wraz z wcześniejszą poprawką dziennika `96cd41c7`.
Po restarcie: API healthy, 79 bloków sprawdzonych / 0 błędnych, NRestarts=0,
MiniMax-M3.1-Flash-Preview HTTP 200 z oczekiwanym znacznikiem, TUI OK,
doctor 47 pass / 13 warn / 0 fail. Konfiguracja, vault i DID nie zmieniły się.
Logi, hashe artefaktów i poprzedni `dist`:
`/home/memphis/.memphis-backup-rotation-lsb_tw25`.
Pozostały indeks Git zachowany bajtowo na poziomie wpisów; nie wykonano push.

Następny krok: przegląd współbieżnych zapisów poświadczeń podczas rotacji oraz
spójności konfiguracji/cache między TS i native. S1 jako całość nie jest jeszcze
odebrane. Testy dotyczą awarii procesu, nie utraty zasilania hosta.

## Kontynuacja S1 — 2026-10-15

Izolacja testów zapisana w commicie `2addd5c4`, dziennik w `96cd41c7`.
Dziennik transakcji sprawdza teraz
wszystkie cele przed publikacją, odrzuca nieprawidłowe dane i powtórzone ścieżki
z aliasami leksykalnymi. 11 testów dziennika przeszło, w tym SIGKILL po każdym
z dwóch zapisów i odzyskanie w nowym procesie oraz stan przygotowanego zamiaru
przed pierwszym zapisem. Są to testy generacji plików, nie pełny odbiór rotacji
zaszyfrowanych poświadczeń. Szczegóły w
[opisie transakcji](../docs/postmortems/2026-10-15-config-transaction-recovery.md).

Kontrole przed commitem wykonują pełny lint. Usunięto blokujące błędy importów
i nieużywaną zmienną w trzech wcześniejszych zmianach; te drobne poprawki nadal
są unstaged przy dotychczasowych zmianach w tool-executor, system.handler i MCP.
Nie mieszać ich automatycznie z commitem dziennika. Prywatny punkt wyjścia indeksu
i patchy: `/home/memphis/.memphis-backup-s1-95wg13kr`.

Następny konkretny krok S1.3: przerwania właściwych operacji rotacji na sztucznym
zaszyfrowanym vaulcie i odczyt wszystkich wpisów po starcie nowego procesu.
Na koniec tego wcześniejszego kroku dziennik nie był jeszcze wdrożony.
Późniejsze wdrożenie jest opisane powyżej. Nie rotowano żywych kluczy.

## Aktualny punkt wznowienia — 2026-10-15

Naprawa lokalnej instalacji wykonana. Przywrócono zgodny stan vaulta i pepper;
zaszyfrowane wpisy, DID i pamięć zachowano. Wartości testowe trafiły wcześniej do
aktywnej konfiguracji. Dokładny historyczny zapisujący proces vault-state nie
jest ustalony; nieszczelne ścieżki testów zostały odizolowane i objęte regresją.

- Zbudowano TypeScript i Rust, wdrożono `dist`, NAPI i natywne TUI.
- 32 pliki / 202 testy TS przeszły w trybie strict; Rust: 444 pass, 2 ignored.
  Lint zmienionych plików przeszedł. Nie uruchomiono całego zestawu testów TS.
- Po wdrożeniu API healthy, integralność: 78 sprawdzonych, 0 błędnych.
  Doctor: 47 pass, 13 warn, 0 fail; natywne TUI preflight: OK.
- Także po drugim kontrolowanym restarcie: API healthy, 0 błędów integralności,
  MiniMax-M3.1-Flash-Preview zwrócił HTTP 200 i oczekiwany znacznik.
- Prywatna kopia sprzed naprawy, logi testów, hashe wdrożonych artefaktów oraz
  poprzedni `dist`: `/home/memphis/.memphis-backup-recovery-20261014-6dvzrbul`.
- Nowy zgodny zestaw odzyskiwania z kontrolą SHA256 i SQLite:
  `/home/memphis/.memphis/backups/recovery-verified-20261015T054147Z`.
- Szczegóły: [postmortem izolacji testów](../docs/postmortems/2026-10-15-vault-test-isolation.md).

Dalej: przegląd i osobne commity tematyczne istniejących wymieszanych zmian,
następnie pełny odbiór S1 (przerwania transakcji i odzyskiwanie), S2 oraz S4.
S1–S9 pozostają nieodebrane jako całość. Nie wykonano rebootu hosta ani push.
Zachować obecny indeks Git; nie commitować zbiorczo wcześniejszych zmian.
Poniższa diagnoza opisuje historyczny stan sprzed wykonania naprawy.

## Potwierdzony stan podczas przeglądu

- Przed zapisaniem tej notatki było 98 zmienionych ścieżek, w tym 8
  nieśledzonych. Zmiany staged i unstaged są wymieszane; ich autorstwa nie
  ustalono. Zachować cały istniejący dorobek.
- `memphis.service`: `ActiveState=failed`, `SubState=failed`,
  `UnitFileState=enabled`, `NRestarts=5`, `Result=start-limit-hit`.
- Journal z 2026-10-14, ostatnia próba startu około 08:36 CEST: kontrola vaulta
  nie odszyfrowała 2 z 2 wpisów, `minimax_api_key` i `did_seed`. Proces zakończył
  się kodem 1. Przyczyna niezgodności konfiguracji lub danych wymaga ustalenia.
- `http://127.0.0.1:3000/health`: połączenie odrzucone.
- Uruchomione `./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.json`
  zakończyło się kodem 2 i błędem
  `src/infra/storage/rust-vault-adapter.ts(906,5): TS18048: 'newVault.master_key' is possibly 'undefined'`.
- Dokumentacja z 12 października opisuje wcześniejszą udaną naprawę vaulta,
  test MiniMax, integrację Omarchy i zestaw odzyskiwania. To wynik historyczny;
  obecna awaria ponownie otwiera naprawę lokalnej instalacji.
- W rozmowie wykonano przegląd i sprawdzenie typów. Nie wykonano naprawy,
  restartu, wdrożenia ani commita. Żaden sprint S1–S9 nie ma tutaj potwierdzenia
  pełnego ukończenia.

## Kolejność prac

1. **Zabezpieczyć punkt wyjścia.** Zachować zmiany staged, unstaged i pliki
   nieśledzone wraz z identyfikatorem bazowego commita. Osobno przygotować
   prywatną kopię konfiguracji, vaulta, tożsamości i baz, z prawidłowymi
   migawkami SQLite. Sekrety pozostają poza historią Git. Przed zmianą danych
   ustalić i zatrzymać procesy, które mogą je zapisywać.
2. **Zdiagnozować vault na kopiach.** Sprawdzić faktyczne ścieżki i źródła
   konfiguracji usługi oraz CLI. Porównać obecny zestaw z kandydatem odzyskiwania
   opisanym w OPERATIONS. Zweryfikować checksum, odszyfrowanie obu wpisów
   i zgodność seedu z publicznym DID, bez wypisywania sekretów. Wyjaśnić, co
   spowodowało ponowną awarię; sam komunikat o odszyfrowaniu nie ustala przyczyny.
3. **Przywrócić usługę minimalną zmianą.** Wybrać zakres na podstawie diagnozy,
   przygotować mapowanie plików i możliwość cofnięcia. Zachować istniejący
   vault i pamięć. Sprawdzić health, doctor, natywne TUI, odczyt pamięci
   i rzeczywistą odpowiedź skonfigurowanego MiniMax; powtórzyć kontrole po
   restarcie procesu. Zanotować wersję rzeczywiście uruchomionego buildu.
4. **Naprawić kompilację i domknąć testy.** Poprawić obsługę nowego klucza
   w `rust-vault-adapter.ts`, obejmując czyszczeniem również błędy podczas
   ponownego szyfrowania. Uruchomić sprawdzenie typów, odpowiednie testy TS/Rust
   i testy przerwania rotacji na sztucznych danych. Wdrożyć wyłącznie sprawdzony
   zakres zmian z gotową możliwością wycofania.
5. **Domykać refaktor etapami.** Po odzyskaniu instalacji: transakcje vaulta
   (S1), uprawnienia (S2), pełne odtwarzanie backupów (S4), diagnostyka
   poświadczeń i usług (S3/S5), kontekst rozmowy (S6), pamięć i indeksy (S7),
   instalacja i aktualizacja Omarchy (S8), odbiór wydania (S9). Każdy temat
   kończyć osobnym commitem, odpowiednimi testami i opisem wycofania.

## Historyczny punkt wznowienia przed naprawą

Zacząć od ponownego odczytu stanu Git i usługi, następnie zabezpieczenia danych
oraz porównania źródeł konfiguracji vaulta. Jeśli błąd kompilacji blokuje
narzędzie potrzebne do diagnozy, poprawić go i przetestować w odizolowanej kopii
przed użyciem na aktywnej instalacji.

Kandydat odzyskiwania opisany w istniejącej procedurze:
`/home/memphis/.memphis/backups/omarchy-recovery-20261012T102232Z/`.
Jego obecność i przydatność trzeba sprawdzić przed odtworzeniem. Dokumentacja
wymienia zgodny zestaw env, vault, DID, konfigurację operatora i migawki baz.
Starszy zestaw `omarchy-repair-2026-10-11T21-46-40-370Z` zawiera także błędną
konfigurację sprzed naprawy.

Nie resetować vaulta, nie wyłączać kontroli integralności i nie testować rotacji
na produkcyjnych sekretach. Zachować dotychczasowe uprawnienia. Stan `healthy`
procesu sprzed restartu nie wystarcza do potwierdzenia trwałej naprawy.

## Dokumenty do kontynuacji

- [Plan S0–S9](../docs/plans/2026-10-12-memphis-refactor/README.md)
- [Procedura obsługi i odzyskiwania](../docs/plans/2026-10-12-memphis-refactor/OPERATIONS.md)
- [Dotychczasowe wykonanie](../docs/plans/2026-10-12-memphis-refactor/EXECUTION.md)
- [Warunki odbioru](../docs/plans/2026-10-12-memphis-refactor/VALIDATION.md)
- [Incydent i naprawa z 12 października](../docs/postmortems/2026-10-12-omarchy-vault-and-launcher-repair.md)
