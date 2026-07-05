<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.zht.md">繁體中文</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.br.md">Português (Brasil)</a> ·
  <a href="./README.bs.md">Bosanski</a> ·
  <a href="./README.da.md">Dansk</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.it.md">Italiano</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.no.md">Norsk</a> ·
  <a href="./README.pl.md"><b>Polski</b></a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.uk.md">Українська</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.gr.md">Ελληνικά</a> ·
  <a href="./README.bn.md">বাংলা</a>
</p>

# OpenCode-DAG

> **Ulepszony fork [opencode](https://github.com/anomalyco/opencode) z produkcyjnym silnikiem workflow DAG do orkiestracji wieloagentowej.**

Zbudowany na bazie terminalowego agenta AI [opencode](https://github.com/anomalyco/opencode) na licencji MIT. **Niepowiązany z ani popierany przez zespół OpenCode.**

---

## Status gałęzi

| Gałąź | Baza | Zawartość | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Optymalizacja narzędzi | ✅ **Stabilny** |
| **`dag-branch`** | main + DAG | Silnik workflow DAG (114 plików) | 🔧 **W trakcie rozwoju** — adaptacja do API v1.17.11 |

> [!IMPORTANT]
> **Silnik workflow DAG jest obecnie portowany** z v1.15.10 do bazy kodu v1.17.11.
> Znajduje się na gałęzi `dag-branch` i **jeszcze nie działa**. Gałąź `main` jest w pełni użyteczna
> z Hooks, Goal Auto-Loop i obsługą wyjątków narzędzi — wszystko gotowe do produkcji.

---

## Co wyróżnia ten fork

### 📌 Stabilny na `main`

#### API Hooks (26 zdarzeń × 5 typów wykonania)

Pełna zgodność z protokołem hooks Claude Code: typy hooków `command`, `mcp`, `http`, `prompt`, `agent` z 26 zdarzeniami hooków, w tym `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` i więcej. Hooki ładowane są z globalnego / projektu / worktree łańcucha `hooks.json`, lub mogą być rejestrowane na sesję w czasie działania przez HTTP-API; opcjonalne sprawdzanie zaufania workspace'u (`requireTrust` + komenda `/trust`) ogranicza wykonywanie hooków do katalogów, które zatwierdziłeś.

Zobacz [referencje hooks](./packages/core/src/plugin/skill/configure-hooks.md).

#### Goal Auto-Loop

Autonomiczna pętla agenta, która stale kieruje agenta w stronę celu zdefiniowanego przez użytkownika. Sędzia LLM decyduje po każdej turze, czy cel został osiągnięty, czy wymaga więcej tur, w ramach konfigurowalnego budżetu tur. `/goal <cel>` aby ustawić, `/subgoal` aby dodać cele cząstkowe, `/goal resume` aby wznowić wstrzymany cel.

#### Obsługa wyjątków narzędzi

- **Naprawa JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — naprawia uszkodzone wielobajtowe ucieczki Unicode w JSON generowanym przez LLM
- **Walidacja narzędzia Question**: ustrukturyzowane formatowanie błędów z podpowiedziami na poziomie pól i przykładami poprawnych wywołań
- **Opisy narzędzi**: rozszerzona dokumentacja `.txt` dla `question`, `task`, `skill`, `webfetch`, `websearch` z sekcjami Parametry i Zwraca
- **Poprawka pipe shella**: `stdout/stderr: "pipe"` we wszystkich wywołaniach `ChildProcess.make` + grzeczne opróżnianie fibra reader'a

### 🔧 W trakcie rozwoju na `dag-branch`

#### Silnik workflow DAG (AGPL-3.0)

**Silnik workflow skierowanego grafu acyklicznego (DAG)**, który pozwala agentom LLM orkiestrować złożone równoległe zadania wielowęzłowe w ramach pojedynczej sesji.

> ⚠️ **Status**: Skopiowany surowo z forka v1.15.10 (114 plików). 217 błędów typów czeka na adaptację API (synchroniczne `Database.use` → oparte na Effect `Database.Service`, `Bus` → `EventV2Bridge` itd.). Jeszcze się nie kompiluje.

| Możliwość | Opis |
|---|---|
| **Automatyczne planowanie** | Uruchamia agentów podrzędnych na podstawie kolejności zależności, równolegle gdzie to możliwe |
| **Dynamiczne przeplanowywanie** | Dodawaj/usuwaj/aktualizuj węzły i dostosowuj współbieżność w trakcie działania |
| **Spójność maszyny stanów** | Cztery żelazne zasady: omijanie maszyny stanów zabronione, stany terminalne nieodwracalne, zdarzenia muszą być rozgłaszane, utrwalaj przed mutacją |
| **Terminal-TUI** | Pełny panel sterowania DAG z mapą topologii znakami blokowymi, widokiem drzewa, dialogami węzłów, aktualizacjami w czasie rzeczywistym |
| **Odzyskiwanie po awarii** | Wykrywa i wznawia osierocone uruchomione workflow'y przy restarcie |
| **Rozgałęzienie warunkowe** | Węzły mogą wykonywać się warunkowo lub być pomijane na podstawie wyjścia upstream |
| **Zagnieżdżanie sub-DAG** | Typ workera `dag` tworzy rekursywne sub-workflow'y (maks. głębokość 3) |
| **Trwała audytowalność** | Schemat SQLite z 6 tabelami, wszystkie przejścia stanów śledzone |

### Poprawki CJK i lokalizacyjne

Rozległe poprawki w obsłudze tekstu chińskiego/japońskiego/koreańskiego: tokenizacja, interpunkcja pełnej szerokości, ścieżki plików, wejście IME w interfejsie terminala. Zobacz [listę poprawek](./docs/localization/zh-hans-fixes.md).

### Podwójna izolacja: Sandbox + Worktree

- **Sandbox** — efemeryczne katalogi tymczasowe z diagnostyką LSP do bezpiecznych eksperymentów z kodem
- **Worktree** — izolacja `git worktree` per-workflow do równoległego wieloagentowego edytowania

---

## Instalacja

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Usuń wersje starsze niż 0.1.x przed instalacją.

---

## Zachowaj upstream — i więcej

Wszystkie możliwości upstream na licencji MIT są w pełni zachowane:

- **Aplikacja desktopowa** (macOS / Windows / Linux) — pobierz z [releases](https://github.com/anomalyco/opencode/releases)
- **Agenci Build & Plan** — `Tab` aby przełączać między trybami pełnego dostępu i tylko do odczytu
- **Wielu dostawców** — Claude, OpenAI, Google, modele lokalne przez [OpenCode Zen](https://opencode.ai/zen)
- **Wbudowane LSP** — diagnostyka w czasie rzeczywistym z serwerów językowych
- **Architektura klient/serwer** — uruchamiaj lokalnie, steruj zdalnie z telefonu

Ten fork dodaje silnik DAG, poprawki CJK, obszar roboczy kodowania sandbox i śledzenie celów na wierzchu — bez psucia czegokolwiek.

---

## Licencja

To repozytorium używa **mieszanego modelu licencji**:

| Zawartość | Licencja | Lokalizacja |
|---------|---------|----------|
| Kod opencode upstream (ogromna większość) | **MIT** | [`LICENSE`](./LICENSE) |
| Samodzielnie rozwijany silnik workflow DAG | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Pełne szczegóły granic w [`NOTICE`](./NOTICE).

> ⚖️ **Dlaczego AGPL?** Silnik DAG to kluczowa zróżnicowana praca. AGPL zapewnia, że każda pochodna — w tym wdrożenia SaaS — musi oddać z powrotem.

---

## Dokumentacja

- [`docs/harness-dag.md`](./docs/harness-dag.md) — architektura i użycie silnika DAG
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — katalog poprawek CJK
- [`NOTICE`](./NOTICE) — granice licencji i przypisanie autorstwa
- [`AGENTS.md`](./AGENTS.md) — przewodnik wkładu i rozwoju

## Społeczność

- 📖 [Społeczność opencode upstream](https://opencode.ai)
- 📝 [Tracker zgłoszeń forka](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
