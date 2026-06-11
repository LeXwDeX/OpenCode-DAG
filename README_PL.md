<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README_EN.md">English</a> ·
  <a href="./README_AR.md">العربية</a> ·
  <a href="./README_BR.md">Português (Brasil)</a> ·
  <a href="./README_BS.md">Bosanski</a> ·
  <a href="./README_DA.md">Dansk</a> ·
  <a href="./README_DE.md">Deutsch</a> ·
  <a href="./README_ES.md">Español</a> ·
  <a href="./README_FR.md">Français</a> ·
  <a href="./README_JA.md">日本語</a> ·
  <a href="./README_KO.md">한국어</a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md"><b>Polski</b></a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (Wersja rozszerzona)

> **⚠️ Oświadczenie**: Ten projekt jest zoptymalizowanym forkiem [opencode](https://github.com/sst/opencode), utrzymywanym przez niezależnego programistę na bazie oryginału. Projekt **nie ma żadnego związku z oficjalnym zespołem OpenCode** i nie jest z nim w żaden sposób powiązany. Oryginalny projekt został wydany na licencji MIT przez zespół opencode. Ten fork zachowuje pierwotną licencję MIT i dodaje kilka samodzielnie opracowanych modułów (szczegóły w [NOTICE](./NOTICE)).

## Wprowadzenie

Ten projekt jest **przerobioną i ulepszoną wersją** oficjalnej wersji opencode, z następującymi celami:

- 🔧 **Naprawa problemów z językiem chińskim**: Debugowanie szeregu problemów z kompatybilnością chińskiego tokenizowania, przetwarzania znaków CJK, interpunkcji o pełnej szerokości, chińskich ścieżek plików oraz chińskiej metody wprowadzania (IME) w wersji upstream (zobacz [lista poprawek chińskich funkcji językowych](./docs/localization/zh-hans-fixes.md))
- 🧩 **Dostarczenie produkcyjnego silnika przepływu pracy DAG**: Autorski [Harness-DAG-Workflow](./docs/harness-dag.md), umożliwiający agentowi LLM orkiestrację i uruchamianie wielowęzłowych zadań równoległych w ramach jednej sesji
- 🎯 **Zachowanie zgodności z upstream**: Cały kod upstream na licencji MIT pozostaje niezmieniony – bez naruszania istniejących kompilacji i bez zanieczyszczania upstreamowych API

## Instalacja

```bash
# Bezpośrednia instalacja (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Menedżery pakietów
npm i -g opencode-ai@latest        # można też użyć bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS i Linux (zalecane, zawsze aktualne)
brew install opencode              # macOS i Linux (oficjalna formuła brew, rzadsze aktualizacje)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Dowolny system
nix run nixpkgs#opencode           # Lub użyj github:anomalyco/opencode dla najnowszej gałęzi dev
```

> [!TIP]
> Przed instalacją usuń starsze wersje (sprzed 0.1.x).

## Unikalne funkcje tej gałęzi

Ta gałąź, oparta na upstreamowym opencode, **dodaje** lub **znacząco ulepsza** następujące możliwości (szczegóły w poszczególnych sekcjach):

| Funkcja | Krótki opis | Licencja |
|------|------|------|
| 🧩 System orkiestracji zadań DAG HARNESS | Umożliwia agentowi LLM orkiestrację wielowęzłowych, równoległych przepływów pracy w jednej sesji | AGPL-3.0 |
| 🪝 Implementacja nadzbioru HOOKS API | Kompletny system hooków z 22 zdarzeniami wykonawczymi × 5 typami wykonania | MIT + ulepszenia tej gałęzi |
| 🛡️ Lekka przestrzeń izolacyjna CODING | Dwutorowe środowisko izolacji: Sandbox + Worktree | MIT + ulepszenia tej gałęzi |
| 🔧 DEBUG funkcji chińskich | Tokenizacja CJK / pełnoszerokie znaki interpunkcyjne / kompatybilność z IME / ścieżki z chińskimi znakami | MIT |
| 🔬 Inne drobne DEBUG | Kopiowanie i wklejanie, szerokość znaków wschodnioazjatyckich, obcinanie chińskich wyników itp. | MIT |

### 🧩 System orkiestracji zadań DAG HARNESS (moduł autorski · AGPL-3.0)

Oryginalnie Harness-DAG-Workflow. Produkcyjny **silnik przepływów pracy w formie skierowanego grafu acyklicznego (DAG)**, który umożliwia agentowi LLM orkiestrację złożonych zadań równoległych w ramach jednej sesji. Kluczowe możliwości:

- **Automatyczne planowanie**: Automatyczne tworzenie agentów podrzędnych na podstawie zależności między węzłami, wykonywanie równoległe
- **Dynamiczne przeplanowywanie**: Możliwość przeplanowywania przepływu pracy w czasie rzeczywistym (dodawanie/usuwanie/modyfikacja węzłów, dostosowywanie limitu równoległości)
- **Żelazne reguły zgodności**: Automat stanów nie do ominięcia, stan końcowy nieodwracalny, każde zdarzenie musi być rozgłaszane, trwałość przede wszystkim
- **Integracja poleceń Slash**: `/dag-ctl` do sterowania działaniem, `/dag-worker` do konfiguracji przepływu pracy
- **Trwała ścieżka audytu**: Schemat 6 tabel w SQLite, wszystkie zmiany stanu są śledzone

Pełna dokumentacja architektury znajduje się w [dokumentacji Harness-DAG-Workflow](./docs/harness-dag.md), a przewodnik programistyczny w [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Licencja**: Ten moduł ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) oraz powiązane szablony i dokumentacja) jest wydany na licencji **GNU AGPL v3** – użycie tego modułu wymaga udostępnienia wszystkich modyfikacji na zasadach open source. Szczegóły w [NOTICE](./NOTICE) i [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 Implementacja nadzbioru HOOKS API

Ta gałąź w pełni zachowuje i rozszerza upstreamowy system HOOKS API:

- **22 zdarzenia wyzwalane w czasie wykonania**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 typów wykonania**: `command` (shell) / `mcp` (narzędzie MCP) / `http` (REST) / `prompt` (jednoetapowy LLM) / `agent` (wieloetapowy LLM)
- **Protokół komunikacji w kopertach JSON przez stdin/stdout**: Pełna dokumentacja protokołu w [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Ulepszenia tej gałęzi**: Integracja z magistralą zdarzeń przepływów pracy DAG (zdarzenia `workflow.*` / `node.*`) + subskrypcja TUI + przekazywanie przez HTTP API

### 🛡️ Lekka przestrzeń izolacyjna CODING

Ta gałąź oferuje dwutorowe środowisko izolacji wykonawczej, umożliwiające agentowi/użytkownikowi testowe uruchamianie kodu w bezpiecznym piaskownicy bez zanieczyszczania faktycznego repozytorium:

| Poziom izolacji | Mechanizm | Zastosowanie |
|---------|------|------|
| **Sandbox** (lekki) | Katalog tymczasowy + diagnostyka LSP + zestaw narzędzi wielojęzykowych (Python/Node/TS/Go/Rust/C/C++) | Uruchamianie pojedynczych plików / małych eksperymentów kodu |
| **Worktree** (ciężki) | Niezależna gałąź `git worktree` + osobny widok systemu plików | Równoległa edycja przez wielu agentów, refaktoryzacja na dużą skalę |

- 📦 **Narzędzie Sandbox**: `packages/opencode/src/tool/sandbox.ts`, każdy sandbox ma niezależną pamięć podręczną zależności (venv / node_modules), obsługuje tryb jednorazowy `ephemeral` i asynchroniczne długotrwałe zadania `background`
- 🌳 **Menedżer Worktree DAG**: W przepływie pracy DAG każdy równoległy węzeł może być automatycznie przypisany do niezależnej gałęzi worktree, a po ukończeniu węzła gałąź jest scalana do głównej linii przez `git merge`

### 🔧 DEBUG funkcji chińskich (naprawione błędy upstream)

Przeprowadzono debugowanie i optymalizację szeregu problemów z kompatybilnością / doświadczeniem użytkownika stwierdzonych w scenariuszach z językiem chińskim w wersji upstream, obejmujące:

- **Chińska tokenizacja i liczenie tokenów**: Obsługa wyjątków znaków CJK w niektórych tokenizerach
- **Kompatybilność z pełnoszerokimi znakami interpunkcyjnymi**: Tolerancja na pełnoszerokie dwukropki, cudzysłowy i nawiasy w analizie konfiguracji
- **Obsługa ścieżek z chińskimi znakami**: Poprawne przekazywanie ścieżek plików zawierających spacje i znaki CJK w hookach / sandboxie
- **Kompatybilność z chińskimi metodami wprowadzania (IME)**: Opóźnienie wprowadzania i drganie kursora w TUI podczas okna kandydatów IME

Szczegółowy zapis poprawek i testy regresyjne w [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Jeśli podczas użytkowania napotkasz inne problemy z obsługą języka chińskiego, zgłoś je w [sekcji zgłoszeń](./issues), podając kroki reprodukcji – będę kontynuować debugowanie.

### 🔬 Inne drobne DEBUG (zintegrowane poprawki upstream)

Ta gałąź w pełni zachowuje poprawki szeregu drobnych problemów z doświadczeniem użytkownika z upstreamu, zweryfikowane testami regresyjnymi:

| Problem | Commit naprawczy upstream | Zakres wpływu |
|------|-----------------|----------|
| 📋 **Uszkodzenie zawartości kopiowania i wklejania** — Zawartość promptu wklejona przez użytkownika jest nieprawidłowo obcinana lub traci znaki w TUI | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | Doświadczenie wprowadzania w TUI |
| 📐 **Układ nie odświeżał się po wklejeniu** — Po wklejeniu długiego tekstu pole promptu nie rozszerzało się automatycznie, tworząc wizualne obcięcie | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | Doświadczenie wprowadzania w TUI |
| 📎 **Brak mechanizmu awaryjnego przy błędzie zapisu do schowka** — Gdy API `navigator.clipboard` zawodzi (np. w środowisku HTTP), operacja kopiowania natychmiast zgłasza błąd | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Zgodność między przeglądarkami |
| 🎨 **Niewystarczający kontrast koloru pierwszoplanowego odznaki wklejania** — Odznaka podsumowania operacji wklejania jest nieczytelna w niektórych motywach | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | Wizualne doświadczenie TUI |
| 📏 **Szacowanie szerokości znaków CJK / wschodnioazjatyckich** — Wyświetlana szerokość znaków wschodnioazjatyckich, takich jak emoji, znaki pełnoszerokie i znaki chińskie, nie odpowiada faktycznemu zajmowanemu miejscu, co powoduje przesunięcie kursora | Włączone do systemu poprawek tokenizacji CJK | Wyrównanie znaków w TUI |
| ⌨️ **Drganie okna kandydatów IME** — Podczas aktywacji chińskiej/japońskiej metody wprowadzania, kursor drży + opóźnienie wstawiania znaków | Lokalna łatka obejściowa | Doświadczenie wprowadzania w TUI |

> Ta gałąź nie odkrywa koła na nowo: problemy naprawione w upstream są synchronizowane z gałęzią `stable` podczas scalania; ta gałąź debuguje głównie problemy związane z chińskimi funkcjami / przepływami pracy DAG, które nie zostały jeszcze rozwiązane w upstream.

## Funkcje zachowane z upstream

Poniższe funkcje pochodzą wyłącznie z upstream opencode (licencja MIT), a ten fork nie wprowadził żadnych zmian funkcjonalnych:

### Aplikacja desktopowa (BETA)

OpenCode jest również dostępny jako aplikacja desktopowa. Można ją pobrać bezpośrednio ze [strony wydań](https://github.com/anomalyco/opencode/releases) lub [opencode.ai/download](https://opencode.ai/download).

| Platforma             | Plik do pobrania                        |
| --------------------- | --------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg`   |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`       |
| Windows               | `opencode-desktop-windows-x64.exe`      |
| Linux                 | `.deb`, `.rpm` lub AppImage             |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agenci

OpenCode ma dwóch wbudowanych agentów. Użyj klawisza `Tab`, aby przełączać się między nimi:

- **build** – Tryb domyślny z pełnymi uprawnieniami, odpowiedni do prac programistycznych
- **plan** – Tryb tylko do odczytu, odpowiedni do analizy i eksploracji kodu
  - Domyślnie odrzuca modyfikacje plików
  - Pyta przed uruchomieniem poleceń bash
  - Przydatny do eksploracji nieznanych baz kodu lub planowania zmian

Dodatkowo zawiera subagenta **general** do złożonych wyszukiwań i zadań wieloetapowych, używanego wewnętrznie, którego można również wywołać wpisując `@general` w wiadomości.

Dowiedz się więcej o [agentach](https://opencode.ai/docs/agents).

### Implementacja nadzbioru ClaudeCode Hooks API

Ten fork w pełni zachowuje upstreamowy system Hooks API i 22 zdarzenia wyzwalane w czasie uruchomienia. Hooki są rejestrowane w polu `hooks` pliku konfiguracyjnego według nazwy zdarzenia i obsługują pięć typów wykonania: `command`, `mcp`, `http`, `prompt` i `agent`. Komunikacja odbywa się za pośrednictwem koperty JSON przez stdin/stdout. Pełna specyfikacja protokołu w [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

Szczegółowa lista zdarzeń i tabela typów wykonania w [rozdziale zachowania funkcji upstream](./docs/readmes/upstream-features.md).

## Licencja i atrybucja

To repozytorium stosuje **mieszany model licencjonowania**:

| Zawartość | Licencja | Lokalizacja |
|-----------|----------|-------------|
| Kod upstream opencode (większość plików) | **MIT** | Zobacz [`LICENSE`](./LICENSE) |
| Autorski silnik przepływu pracy DAG (`packages/opencode/src/dag/` i powiązane narzędzia, szablony, dokumentacja) | **GNU AGPL v3** | Zobacz [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Pełny opis granic w pliku [`NOTICE`](./NOTICE).

### 🔒 AGPL v3 Obowiązkowe oświadczenie licencyjne (twarde ograniczenie tej gałęzi)

**Polityka autora projektu dotycząca dalszego rozwoju tego repozytorium:**

1. **Kod opracowany samodzielnie musi być objęty licencją GNU AGPL v3** — każdy kod dodany, przepisany lub znacząco zmodyfikowany przez autora tej gałęzi **musi** być objęty licencją GNU Affero General Public License w wersji 3 lub nowszej (AGPL-3.0-or-later)
2. **Wymóg „zaraźliwości” AGPL** — każdy projekt, który wykorzystuje, modyfikuje lub wywodzi się z modułów na licencji AGPL-3.0 (silnik przepływu pracy DAG itp.), **musi udostępnić swój pełny kod źródłowy na licencji AGPL-3.0** oraz zapewnić dostęp dla użytkowników końcowych
3. **Obowiązek otwarcia kodu w przypadku SaaS** — jeśli wdrażasz ten projekt lub jego dzieła pochodne jako usługę sieciową (SaaS / platformę chmurową), **musisz udostępnić link do pobrania pełnego kodu źródłowego wszystkim użytkownikom korzystającym z tej usługi** (jest to kluczowy zapis odróżniający AGPL od GPL, §13)
4. **Zachowanie informacji o autorze** — należy zachować oświadczenie pierwotnego autora, oznaczenia praw autorskich oraz informacje o pochodzeniu w pliku NOTICE

> ⚖️ **Dlaczego AGPL?** Autor uważa, że wartość oprogramowania open source tkwi w ciągłej współpracy. AGPL zapobiega szkodzeniu społeczności open source przez „zamknięte SaaS-y” — każdy komercyjny użytkownik czerpiący korzyści z tego projektu musi oddać coś społeczności.

**Części na licencji MIT nie podlegają tym warunkom** i są kontrolowane wyłącznie przez zespół opencode.

### Relacje z oryginalnym zespołem opencode

- ✅ Ten projekt **opiera się** na kodzie źródłowym [opencode](https://github.com/sst/opencode)
- ❌ Ten projekt **nie jest w żaden sposób powiązany ani autoryzowany** przez oficjalny zespół opencode (sst / anomalyco)
- ❌ Ten projekt nie jest oficjalnym wydaniem opencode i nie udziela żadnych gwarancji wsparcia w odniesieniu do oficjalnego źródła
- ❌ **Oficjalny zespół OpenCode nie zapewnia żadnego wsparcia technicznego, gwarancji ani poparcia dla tej gałęzi** (zgodnie z wyraźnym wymogiem w README oryginalnego projektu)
- ✅ Silnik przepływu pracy DAG, funkcje w języku chińskim, DEBUG i inne ulepszenia tego projektu są niezależnie utrzymywane przez autora
- ✅ Autorstwo i prawa autorskie kodu źródłowego MIT z oryginalnego projektu są w całości zachowane, bez żadnych zmian w deklaracjach autorów i praw autorskich

Aby skorzystać z oficjalnej wersji opencode, odwiedź https://opencode.ai lub https://github.com/sst/opencode .

## Indeks dokumentacji

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Pełna dokumentacja Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Lista poprawek chińskich funkcji językowych
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Opis zachowanych funkcji upstream opencode
- [`NOTICE`](./NOTICE) — Granice licencji i oświadczenie o atrybucji
- [`AGENTS.md`](./AGENTS.md) — Przewodnik po dalszym rozwoju i wkładzie

## Wkład

Przed przesłaniem PR przeczytaj [`CONTRIBUTING.md`](./CONTRIBUTING.md), jeśli jesteś zainteresowany wniesieniem wkładu.

### Rozwój oparty na tym forku

Jeśli używasz "opencode" w nazwie projektu (np. "opencode-dashboard" lub "opencode-mobile"), podaj w README, że projekt nie jest oficjalnie rozwijany przez zespół OpenCode i nie jest powiązany z autorem tego forka.

## Często zadawane pytania (FAQ)

### Jaka jest różnica w porównaniu z Claude Code?

Funkcjonalnie dość podobne, z kluczowymi różnicami:

- 100% open source
- Nie jest powiązany z konkretnym dostawcą. Zalecane modele [OpenCode Zen](https://opencode.ai/zen), ale można też używać z Claude, OpenAI, Google lub modelami lokalnymi
- Wbudowana obsługa LSP
- Fokus na interfejsie terminalowym (TUI)
- Architektura klient/serwer. Może działać lokalnie, a jednocześnie być zdalnie sterowany z urządzenia mobilnego
- **🪝 Nadzbiór Hooks API**: bazując na 22 zdarzeniach wyzwalających × 5 typach wykonania Claude Code, ten fork jest **w pełni zgodny z protokołem Claude Code Hooks** i dodatkowo oferuje integrację magistrali zdarzeń DAG (`workflow.*` / `node.*`), subskrypcje TUI oraz przekazywanie przez HTTP API. Pełna specyfikacja: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 System instrukcji Goal**: narzędzie `todowrite` + strukturalne śledzenie celów utrzymują kolejkę pracy agent podczas długich, wieloetapowych sesji i zapobiegają utracie stanu zadań przy zmianach okna kontekstu
- **🪝 TODO PreHook**: obsługuje wstrzykiwanie listy TODO do kontekstu przez hooki `PreToolUse`; mechanizm powrotu do celów oparty na hooks sprawia, że agent zawsze widzi bieżący postęp
- **🛡️ Sandbox Coding Workspace**: każdy sandbox ma osobny katalog tymczasowy, diagnostykę LSP i wielojęzyczne toolchainy (Python/Node/TS/Go/Rust/C/C++); agent może izolowanie testować, kompilować i debugować kod, a po weryfikacji przenieść zmiany do projektu przez edit/write

### Jaka jest różnica w porównaniu z oficjalną wersją opencode?

- **🪝 Nadzbiór Hooks API + instrukcje Goal + TODO PreHook + Sandbox Workspace**: zachowuje wszystkie upstreamowe możliwości Hooks oraz dodaje integrację zdarzeń DAG, strukturalne śledzenie zadań, powrót do celów sterowany hooks i izolowany wielojęzyczny coding sandbox
- **🧩 Tryb DAG WorkFlow (WIP · około 90%)**: autorski silnik [Harness-DAG-Workflow](./docs/harness-dag.md), który pozwala LLM agent orkiestrwać wielowęzłowe zadania równoległe w jednej sesji. Główne możliwości są już wdrożone (planowanie / cykl życia / pause-resume-cancel-replan-step / sub-DAG / gałęzie warunkowe / data flow / crash recovery / probes), panel TUI jest podłączony, a końcowe dopracowanie trwa
- **🔧 Poprawki kompatybilności z językiem chińskim**: ciągły DEBUG tokenizacji CJK, znaków pełnej szerokości, chińskich ścieżek i przypadków IME odziedziczonych z upstream
- Długoterminowe niezależne utrzymanie, uniezależnione od tempa upstream

## Społeczność

- 📖 [Społeczność upstream opencode](https://opencode.ai)
- 📝 [Sekcja issue tego forka](./issues) (zgłaszanie błędów i propozycje nowych funkcji)
