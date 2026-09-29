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
