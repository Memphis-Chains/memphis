# Lista PKD dla JDG z VAT 23% od dnia 1

> Źródło: GUS (PKD 2007) + moja analiza 2026-09-27.
> Decyzja: `tui-1790544602726`.
> Kontekst: Wodzu (operator) chce prowadzić JDG z obowiązkowym VAT 23% od dnia pierwszej sprzedaży (bez korzystania ze zwolnienia podmiotowego do 200k PLN/rok).

---

## Przeważające

| Kod | Nazwa | Po co |
|---|---|---|
| **47.91.Z** | Sprzedaż detaliczna prowadzona przez domy sprzedaży wysyłkowej lub Internet | Własny sklep, marketplace (Allegro, Etsy, Amazon), dropshipping, aukcje |

## Dodatkowe — rdzeń (core dla modelu e-commerce + custom Szczepan)

| Kod | Nazwa | Kiedy potrzebujesz |
|---|---|---|
| **46.90.Z** | Sprzedaż hurtowa niewyspecjalizowana | Jeśli sprzedajesz też B2B do dealerów (dsmxshop → cross-sell dealerów Can-Am) |
| **13.92.Z** | Produkcja gotowych wyrobów tekstylnych | Jeśli szyjesz canopies, pokrowce (Szczepan) |
| **31.00.Z** | Produkcja mebli | Jeśli robisz siedziska/siedzenia custom |
| **62.01.Z** | Działalność związana z oprogramowaniem | Watra.ai, subskrypcje cyfrowe, knowledge packs B2C |
| **63.99.Z** | Pozostała działalność usługowa w zakresie informacji, gdzie indziej niesklasyfikowana | Content, knowledge packs B2C, bazy danych |
| **52.10.A** | Magazynowanie i przechowywanie towarów | Jeśli masz własny magazyn / fulfilment |

## Dodatkowe — opcjonalne (jeśli dajesz też usługi / consulting)

| Kod | Nazwa | Kiedy potrzebujesz |
|---|---|---|
| **62.02.Z** | Działalność związana z doradztwem w zakresie informatyki | Jeśli dajesz konsulting IT |
| **62.09.Z** | Pozostała działalność usługowa w zakresie technologii informatycznych i komputerowych | Inne usługi IT niewymienione wyżej |
| **70.22.Z** | Pozostałe doradztwo w zakresie prowadzenia działalności gospodarczej i zarządzania | Konsulting biznesowy (np. dla innych e-commerce) |
| **73.12.C** | Pośrednictwo w sprzedaży miejsca na cele reklamowe w mediach elektronicznych (Internet) | Afiliacja, agencja reklamowa |
| **74.90.Z** | Pozostała działalność profesjonalna, naukowa i techniczna, gdzie indziej niesklasyfikowana | Catch-all na usługi profesjonalne |
| **82.92.Z** | Działalność związana z pakowaniem | Jeśli sam pakujesz na dużą skalę (rzadko) |
| **53.20.Z** | Pozostała działalność pocztowa i kurierska | Własna wysyłka (najczęściej wystarczy kurier jako klient) |
| **96.09.Z** | Pozostała działalność usługowa, gdzie indziej niesklasyfikowana | Ostatnia deska ratunku dla nietypowych usług |

---

## Moja rekomendacja dla Twojej sytuacji (Wodzu)

Jeśli ruszasz **Watra.ai B2C + dsmxshop/Szczepan + własne projekty** — dodaj wszystkie te:

```
47.91.Z  przeważające — sprzedaż detaliczna online
46.90.Z  dodatkowe    — hurt B2B
13.92.Z  dodatkowe    — canopies tekstylia (Szczepan)
31.00.Z  dodatkowe    — siedziska custom
62.01.Z  dodatkowe    — IT (Watra.ai, subskrypcje)
63.99.Z  dodatkowe    — knowledge packs B2C
52.10.A  dodatkowe    — magazyn (jeśli planujesz)
70.22.Z  dodatkowe    — doradztwo biznesowe
```

To kompletny zestaw na maksa bezpieczeństwa i elastyczności. Możesz na starcie usunąć **52.10.A** jeśli nie masz magazynu.

### Wariant minimalny (szybki start, gdyby chciał ograniczyć)

```
47.91.Z  przeważające
46.90.Z  dodatkowe (hurt B2B)
13.92.Z  dodatkowe (canopies)
62.01.Z  dodatkowe (IT/Watra)
```

To minimum na pierwsze 12 miesięcy — zawsze możesz dopisać kolejne PKD przez CEIDG.

---

## Rejestracja w CEIDG + VAT

### Krok po kroku

1. **Profil Zaufany** — zakładka na stroniefo.gov.pl (lub przez bankowość internetową)
2. **CEIDG → zmiana wpisu** (online, bezpłatnie)
   - Kod **przeważające**: 47.91.Z
   - Kod **dodatkowe**: lista z sekcji powyżej
   - Data powstania obowiązku podatkowego VAT (najczęściej: data pierwszej sprzedaży, ale można ustawić dowolnie)
3. **ZUS** — formularz ZUS ZUA / ZUS ZFA (online przez PUE ZUS)
   - **Ulga na start** przez 6 miesięcy (0 PLN) — jeśli nie byłeś wcześniej przedsiębiorcą przez ostatnie 60 miesięcy
   - Po 6 miesiącach: **mały ZUS** (lub pełny, jeśli przychód > limit)
4. **VAT-R** — zgłoszenie rejestracyjne do US (online lub papierowo)
   - **Termin**: do dnia poprzedzającego dzień pierwszej czynności opodatkowanej, a w niektórych przypadkach — 7 dni od dnia, w którym zgłosiłeś w CEIDG "czynny VAT od [data]"
5. **US przyjmie zgłoszenie** → dostaniesz numer VAT (z reguły ten sam co NIP)

### Wymogi obok PKD (obowiązkowe)

| Wymóg | Kiedy |
|---|---|
| **Kasa fiskalna online** | **Od dnia pierwszej sprzedaży** (obowiązek natychmiastowy w e-commerce, nie ma okresu przygotowawczego) |
| **JPK_V7M / V7K** | Miesięcznie lub kwartalnie do 25. dnia następnego okresu |
| **Regulamin sklepu** | Przed pierwszą sprzedażą |
| **Polityka prywatności + cookies (RODO)** | Przed pierwszą sprzedażą |
| **Biała lista VAT** | Przy B2B — weryfikacja kont dostawców |
| **Ewidencja VAT** | Prowadzona na bieżąco (program księgowy, arkusz, system ERP) |

---

## Aspekty podatkowe

### VAT

- **Stawka podstawowa: 23%** (od dnia 1. = czynny VAT-owiec bez zwolnienia)
- Niektóre towary mają obniżone stawki: 8% (np. żywność, usługi transportowe), 5% (np. książki, e-booki, prasa), zw. (np. usługi medyczne)
- **Towary cyfrowe** (e-booki, subskrypcje Watra.ai knowledge packs B2C): 23% (od 2015 r. obowiązują przepisy o MOSS / OSS, ale wewnątrzwspólnotowo)
- **Stawka 0%**: eksport towarów (B2B poza UE), WNT (wewnątrzwspólnotowe nabycie towarów)
- **VAT przy imporcie** (z Chin np.): 23% + cło

### PIT

- **Skala 12%/32%** (domyślna): próg 120 000 PLN/rok
- **Liniowy 19%** (popularny dla e-commerce): bez limitu, ale bez kwoty wolnej, bez wspólnego opodatkowania
- **Ryczałt** (8% handel / 12% usługi): uwaga — **niektóre PKD z listy powyżej są niezgodne z ryczałtem** (np. 70.22.Z, 62.02.Z, 74.90.Z)

### ZUS

- **Ulga na start** (6 mies. 0 PLN) — jeśli warunek 60-miesięczny spełniony
- **Mały ZUS** (przez kolejne 2 lata) — podstawa zależy od przychodu
- **Mały ZUS+** (po 2 latach łącznie mały ZUS)
- **Pełny ZUS** od 4. roku
- Składka zdrowotna **9%** podstawy (uzależniona od formy opodatkowania)

---

## Mapowanie na Twoje projekty

| Projekt | PKD |
|---|---|
| **dsmxshop.com** (Szczepan, /usa /extra /bonus) | 47.91.Z + 46.90.Z + 13.92.Z + 31.00.Z |
| **Watra.ai** (knowledge packs B2C/B2B) | 47.91.Z (B2C detal) + 62.01.Z + 63.99.Z |
| **memphis-v5.pl** (strona ofertowa, nie sklep) | Brak (to nie sprzedaż towarów; jeśli konsulting → 62.02.Z / 70.22.Z) |
| **Etsy / handmade** | 47.91.Z |
| **Własny sklep na Shopify** | 47.91.Z |

---

## Anti-confab

- **To nie jest porada prawna ani podatkowa.** Przy dużej skali (cross-border B2C do US/UK, import z Chin, OSS/IOSS, >200k PLN/rok) skonsultuj z **księgową specjalizującą się w e-commerce** lub **doradcą podatkowym**.
- **Stawki VAT dla towarów się zmieniają** — sprawdź aktualną listę przed wyborem asortymentu.
- **Niektóre PKD są niezgodne z ryczałtem** — jeśli planujesz ryczałt, lista się zawęża (np. 70.22.Z nie może być na ryczałcie).
- **Numery PKD, nazwy i opisy** na dzień 2026-09-27 — ostatnia aktualizacja PKD: 2025. Sprawdź czy nie ma nowszych zmian (np. PKD 2007 z późniejszymi nowelizacjami).
- **Nie pobrałem treści opisowej GUS bezpośrednio** (ich wyszukiwarka to aplikacja Vaadin JS).
- **Aktualne stawki ZUS, progów ZUS, kwoty wolne PIT** — do weryfikacji w PUE ZUS / u księgowej (zmieniają się co rok).

---

## Powiązane pliki / decyzje

- `docs/pkd/47-91-z.md` — pełny research o PKD 47.91.Z
- Decyzja `tui-1790544602726` (ten plik)
- Decyzje #104–#121 (Szczepan, dsmxshop)
- Decyzje o Memphis pivot (Agora / Unit / Chain) — wykracza poza sprzedaż online

---

*Wygenerowane 2026-09-27 przez Memphis runtime. Na podstawie ogólnodostępnych źródeł (GUS PKD 2007, polskie przepisy podatkowe i ubezpieczeniowe) + pamięci o poprzednich sesjach. NIE stanowi porady prawnej ani podatkowej — finalną decyzję skonsultuj z księgową lub doradcą podatkowym specjalizującym się w e-commerce.*
