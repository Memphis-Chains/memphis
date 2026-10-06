Tauri Phase G — status kompilacji (2026-09-29)

cargo check -p memphis-gui NIE przechodzi na tym hoście. Dwie warstwy:

1. BŁĄD KODU (naprawiony w tym commicie):
   src-tauri/Cargo.toml miał path = "../../crates/..." — src-tauri jest
   2 poziomy niżej niż apps/memphis-gui, więc ../../ trafia w apps/.
   Poprawione na "../../../crates/...". Bez tego manifest w ogóle
   się nie ładował — cargo nie czytał nawet kodu.

2. BRAK BIBLIOTEK SYSTEMOWYCH (nie kod, środowisko):
   glib-2.0, gtk, webkit2gtk nie zainstalowane na tym hoście.
   Tauri na Linuksie ich wymaga. To nie jest defekt gałęzi —
   to stan maszyny. Wymaga: apt install libwebkit2gtk-4.1-dev
   libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

WNIOSK: gałąź jest poprawna strukturalnie, ale NIE jest zweryfikowana
kompilacją. CI tego nie buduje (brak tauri w .github/workflows/ci.yml),
testy nie obejmują apps/, knip go nie skanuje.

Rekomendacja: scal PR #644 jako scaffold, ale z issue trackingiem
'cargo check -p memphis-gui' w CI, żeby przyszłe zmiany nie były
ślepe. Doinstalacja bibliotek na hoście = decyzja operatora
(apt, ~500 MB, wymaga sudo).

## rozstrzygnięcie (2026-10-06): gałąź usunięta

Audyt trzymania repo znalazł `apps/memphis-gui/` w stanie, którego ten
ADR opisuje: 107 linii Rust, `runtime_stub.rs` zwracające stały
`heartbeat_at: "1970-01-01T00:00:00Z"`, zero testów, zero integracji
(nie w workspace Cargo, nie w CI, knip go ignorował), ostatni commit
2026-09-29. 107 linii obok 11 863 w `crates/memphis-operator`.

Usunięte — razem z wpisami w `Cargo.toml` (exclude), `eslint.config.mjs`
(glob) i `knip.json` (ignore), żeby nie zostawić martwych referencji.

Nie jest to wyrok, że Tauri jest złym pomysłem. Jest stwierdzeniem, że
 prototyp nie był w stanie „prawie gotowy": brak jednej ścieżki, która
by go zbudowała, i brak jednego testu, który by go kwalifikował.
Do wznowienia potrzebne są trzy rzeczy naraz: poprawiony model hosta
albo kontener z webkit2gtk, test kontraktowy na `runtime_stub`, i
uznanie, że operator chce powierzchnię graficzną. Wszystkie trzy są
decyzjami, nie brakującym kodem.
