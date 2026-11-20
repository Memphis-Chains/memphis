# Publiczny czat Memphisa

Formularz działa pod `/chat/`. Na hoście operatora jest dostępny pod adresem `http://127.0.0.1:9100/chat/`. Publiczna strona wysyła żądania HTTPS do `./api.php`. PHP łączy się z bramą przez prywatne gniazdo SSH poza katalogiem strony. Rdzeń operatora słucha na porcie 3000 na interfejsie lokalnym.

## Odpowiedź i źródła

Przeglądarka przekazuje pytanie i najwyżej dwie poprzednie wymiany. Na stronie publicznej domyślnie wybrany jest MiniMax-M3, a na adresie pętli zwrotnej Bielik. Zmiana modelu rozpoczyna nową rozmowę. Brama ogranicza krótkie serie do 10 wiadomości na 10 sekund z jednego adresu. Może obsługiwać do czterech żądań jednocześnie, w tym jedno generowanie na lokalnej Ollamie.

Basal klasyfikuje pytanie na hoście. Do katalogu publicznego trafiają wpisy z łańcuchów `journal`, `decisions` i `insights`, które zawierają tag `public-chat` i jawne pole `consent=exportable`. Czytnik uwzględnia późniejsze adnotacje zgody z dziennika. Po klasyfikacji ponownie sprawdza zgodę na konkretny blok. Do pytania może dołączyć jeden fragment o długości do 240 znaków. Użytkownik może rozwinąć źródło pod odpowiedzią.

Tryb internetowy korzysta z dostawcy skonfigurowanego w sejfie rdzenia. Rdzeń udostępnia publicznej bramie tylko klasyfikację i generowanie tekstu przez prywatne gniazdo Unix. W przypadku niedostępności klasyfikacji lub dostawcy brama próbuje lokalnego Bielika. Etykieta podaje model, który rzeczywiście odpowiedział.

## Uruchomienie na hoście

1. Zbuduj Memphis i zainstaluj lokalną Ollamę. Pobierz model poleceniem `ollama pull SpeakLeash/bielik-4.5b-v3.0-instruct:Q8_0`.
2. Jednostka `memphis-public-basal.service` wskazuje wersję silnika, katalog modelu i plik GGUF. Umieść w tych ścieżkach zweryfikowane wydanie silnika, wagi i pasujący tokenizer z kalibracją. Jednostka uruchamia klasyfikator offline na `127.0.0.1:18000`. Starsza usługa na porcie 8000 może osobno obsługiwać konsolę operatora.
3. W instalacji linuksowej w `~/memphis` uruchom `npm run build:rust:release` przy każdym wydaniu. Zainstaluj jednostki `memphis-public-basal.service` i `memphis-public-chat-gateway.service` oraz pliki `memphis.service.d/40-production.conf` i `memphis.service.d/50-public-minimax.conf` ze `scripts/systemd/` w katalogu jednostek użytkownika. Przy starcie rdzeń pobiera bibliotekę NAPI z kompilacji wydaniowej do prywatnego katalogu w `$XDG_RUNTIME_DIR`. Przeładuj systemd, uruchom klasyfikator i bramę oraz zrestartuj rdzeń. Parametr `PUBLIC_CHAT_GPU_LAYERS` bramy reguluje użycie GPU przez Bielika. Na hoście i3 z GTX 960 użyto 14 warstw, aby jednocześnie mieścił się model wyszukiwania.
4. Dla hostingu z PHP i cURL przygotuj klucz konta hostingowego, sprawdzony klucz hosta SSH i katalog `~/.memphis-chat/run` dostępny wyłącznie dla właściciela. Zainstaluj `memphis-public-chat-tunnel.service`. Wgraj pliki z `sites/memphis-v5/chat/` do katalogu `chat/` strony. Przed podmianą zachowaj dotychczasowe pliki poza katalogiem WWW.

## Sprawdzenie i wycofanie

```bash
memphis status --json
memphis health --json
memphis slo status --days 7 --json
curl --fail http://127.0.0.1:9100/healthz
curl --fail http://127.0.0.1:18000/health
```

W przeglądarce wyślij pytanie o modele czatu oraz pytanie uzupełniające. Sprawdź model pod odpowiedzią i rozwiń odwołanie do wpisu pamięci, jeśli jest widoczne. W razie wycofania dostępu internetowego zatrzymaj `memphis-public-chat-tunnel.service`. Lokalny formularz ma własny adres na porcie 9100.

Przykład Kubernetes wystawia wyłącznie bramę czatu. Świeży wolumen Ollamy wymaga pobrania modelu. Przed zmianą istniejącego wdrożenia zachowaj spójną kopię SQLite z dotychczasowego `/app/data` i odtwórz ją na PVC w ścieżce wskazanej przez nowy `DATABASE_URL`. Konfiguracja MiniMax z gniazdem Unix i Basalem opisana powyżej dotyczy wdrożenia systemd.
