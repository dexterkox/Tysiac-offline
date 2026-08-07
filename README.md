# Tysiąc — wersja na App Store

Projekt gotowy do zbudowania **bez komputera**. Wszystko robisz w przeglądarce na telefonie.

---

## Co jest w środku

Wszystkie pliki leżą płasko w głównym katalogu — foldery tworzą się same
podczas kompilacji (`node setup.js prepare`). Dzięki temu wgranie projektu
z telefonu to jedno przeciągnięcie plików, bez zakładania katalogów.

| Plik | Do czego służy |
|---|---|
| `index.html` | Cała gra — działa w 100% offline, nic nie pobiera z sieci |
| `MultipeerPlugin.swift` | Wtyczka łączenia bez sieci — iOS |
| `MultipeerPlugin.kt` | Wtyczka łączenia bez sieci — Android |
| `www/lan-glue.js` | Spina przeglądarkę serwerów z silnikiem gry |
| `capacitor.config.json` | Konfiguracja aplikacji natywnej |
| `setup.js` | Układa strukturę i wpina wtyczki natywne |
| `codemagic.yaml` | Budowanie i wysyłka do App Store w chmurze |

---

## Zacznij od Androida

Android jest **znacznie szybszy do sprawdzenia** i nic nie kosztuje:

- nie potrzeba konta w sklepie ani recenzji,
- dostajesz plik **APK** i instalujesz go bezpośrednio na telefonie,
- ta sama gra i ten sam mechanizm łączenia bez sieci, co na iOS.

**Jak to zrobić:**
1. Wgraj projekt na GitHub (patrz niżej).
2. W Codemagic uruchom workflow **`android-apk`** — wcześniej podmień adres e-mail
   w `codemagic.yaml` na swój.
3. Po ~10 minutach dostaniesz mailem link do pliku APK.
4. Otwórz link na telefonie z Androidem i zainstaluj (system poprosi o zgodę
   na instalację z nieznanego źródła — trzeba się zgodzić).
5. Przy pierwszym uruchomieniu zgódź się na **Bluetooth i urządzenia w pobliżu**.

**Uwaga o testowaniu:** żeby sprawdzić granie we dwoje bez sieci, potrzebne są
**dwa telefony z Androidem**. Mając jeden, zobaczysz działającą grę i tryby solo,
ale połączenia między telefonami nie przetestujesz. Aplikacja na Androida
**nie połączy się** z aplikacją na iPhonie — to dwa różne systemy łączenia.

## Czego brakuje po Twojej stronie

**Tylko dla iOS — konto Apple Developer, 99 USD/rok.** Do wersji na Androida nie jest potrzebne.
Bez konta Apple nie da się nic opublikować w App Store. Rejestracja
przez aplikację **Apple Developer** na iPhonie. Weryfikacja trwa zwykle 1–2 dni.

---

## Krok po kroku

### 1. GitHub (przeglądarka na telefonie)
1. Załóż konto na `github.com`.
2. Utwórz **prywatne** repozytorium `tysiac`.
3. Wgraj zawartość tej paczki (przycisk *Add file → Upload files*).

### 2. Klucz App Store Connect
1. `appstoreconnect.apple.com` → **Users and Access** → **Integrations** → **App Store Connect API**.
2. Utwórz klucz z rolą **App Manager**.
3. Zapisz **Issuer ID**, **Key ID** i pobrany plik **.p8** (pobierzesz go tylko raz).

### 3. Rejestracja aplikacji
1. W App Store Connect → **Apps** → **+** → **New App**.
2. Bundle ID: `pl.tysiac.gra` (utwórz go wcześniej w portalu Certificates, Identifiers & Profiles).
3. Nazwa: `Tysiąc`, język: polski, kategoria: **Games → Card**.

### 4. Codemagic
1. `codemagic.io` → zaloguj przez GitHub → dodaj repozytorium.
2. **Teams → Integrations → App Store Connect** → wklej Issuer ID, Key ID i plik .p8.
   Nazwij integrację dokładnie **`TysiacKey`** (tak jest w `codemagic.yaml`).
3. Utwórz grupę zmiennych **`appstore`**, a w niej `APP_STORE_APP_ID` — numer aplikacji
   widoczny w adresie App Store Connect.
4. Uruchom workflow **ios-appstore**.

Pierwsza kompilacja trwa 10–20 minut. Efekt trafia do **TestFlight**, gdzie zainstalujecie
grę na swoich telefonach i sprawdzicie ją na żywo.

### 5. Wysyłka do recenzji
Gdy TestFlight potwierdzi, że wszystko działa:
1. W `codemagic.yaml` zmień `submit_to_app_store` na `true`.
2. W App Store Connect uzupełnij opis, zrzuty ekranu (zrobisz je telefonem),
   politykę prywatności i **Age Rating**.
3. Wyślij do recenzji. Apple odpowiada zwykle w 1–3 dni.

---

## Dwa sposoby łączenia — który wybrać

W grze są dwa tryby, przełączane w lobby. Żaden nie wymaga internetu.

### 📶 W pobliżu — bez żadnej sieci
Telefony łączą się bezpośrednio przez Bluetooth i Wi-Fi peer-to-peer, jak przy AirDropie.
Nie trzeba niczego konfigurować.

**Ograniczenie: tylko ten sam system.** iPhone połączy się z iPhonem, Android z Androidem.
Apple i Google używają tu zamkniętych, niezgodnych ze sobą mechanizmów (MultipeerConnectivity
kontra Nearby Connections) i nie da się ich pogodzić.

### 🔗 iPhone ↔ Android — przez hotspot
Jeden telefon włącza **hotspot osobisty**, drugi łączy się z nim przez Wi-Fi. Powstaje sieć
lokalna — **pakiet danych ani internet nie są potrzebne**, sam hotspot wystarczy. Gra wykrywa
przeciwnika przez Bonjour i łączy się przez WebSocket, a oba te standardy działają tak samo
na iOS i na Androidzie.

To **jedyny sposób na grę między iPhonem a Androidem** i działa w samolocie.

> Uwaga: w przeglądarce ten tryb zawodził, bo Safari ukrywa adres telefonu nadającego hotspot.
> W aplikacji natywnej to ograniczenie nie występuje — mamy pełny dostęp do gniazd sieciowych.

## Jak działa łączenie bez sieci

W samolocie nie ma Wi-Fi ani internetu, więc gra używa **MultipeerConnectivity** —
tego samego mechanizmu co AirDrop. Telefony łączą się bezpośrednio przez Bluetooth
i Wi-Fi peer-to-peer. Nie potrzeba routera, hotspotu ani jakiejkolwiek sieci.

W praktyce: jeden zakłada grę, drugi widzi ją na liście „Gry w pobliżu" i dołącza.
Zasięg to kilkanaście metrów, więc przy sąsiednich fotelach jest z zapasem.

Przy pierwszym uruchomieniu iOS zapyta o zgodę na łączenie z urządzeniami w pobliżu —
**trzeba się zgodzić**, inaczej lista pozostanie pusta.

Gdyby na jakimś urządzeniu ten tryb nie działał, gra automatycznie użyje wyszukiwania
przez wspólne Wi-Fi, a w ostateczności parowania kodem.

## Uczciwie o ryzyku

**Apple potrafi odrzucać aplikacje będące opakowaną stroną internetową** (zasada 4.2,
*Minimum Functionality*). Nasza gra jest w znacznie lepszej sytuacji niż typowy taki
przypadek, bo:

- działa **całkowicie offline**, nie wczytuje żadnego adresu z internetu,
- ma **funkcję niedostępną dla stron** — wyszukiwanie gier w sieci lokalnej,
- to pełna gra z własną logiką, a nie skrót do serwisu.

Mimo to gwarancji nie ma. Jeśli recenzent odrzuci wersję, dostaniesz konkretny powód
i wtedy dobudujemy to, czego zażąda.

**Druga sprawa:** wtyczki natywnej nie dało się skompilować w tym środowisku — nie ma tu
Xcode. Kod Swift jest napisany według standardowego API MultipeerConnectivity, ale
**pierwsza kompilacja w Codemagic jest jego pierwszym prawdziwym testem**. Gdyby coś
nie zagrało, błąd pojawi się w logu kompilacji i wtedy to poprawimy — gra ma dwie
ścieżki zapasowe, więc nie zostaniesz bez działającej wersji.

---

## Kolejność, którą polecam

1. TestFlight na dwa telefony → sprawdźcie wyszukiwanie gier w sieci.
2. Dopiero potem recenzja App Store.

Dzięki temu ewentualne problemy z siecią lokalną wyjdą, zanim aplikację zobaczy recenzent.
