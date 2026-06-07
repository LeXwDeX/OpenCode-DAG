<!--
**Machine Translation Notice**
This document was machine-translated from Chinese (zh-CN) to Deutsch using DeepSeek v4 Pro.
Source: README.md (Chinese original)
Translation model: deepseek-v4-pro (http://192.168.33.110:8000/v1)
Date: 2026-06-07
For authoritative information, refer to the original Chinese version: README.md
-->

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
  <a href="./README_DE.md"><b>Deutsch</b></a> ·
  <a href="./README_ES.md">Español</a> ·
  <a href="./README_FR.md">Français</a> ·
  <a href="./README_JA.md">日本語</a> ·
  <a href="./README_KO.md">한국어</a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (Erweiterte Edition)

> **⚠️ Hinweis**: Dieses Projekt ist ein auf [opencode](https://github.com/sst/opencode) basierender Fork, der von einem unabhängigen Entwickler gepflegt wird. Es besteht **keine Verbindung zum offiziellen OpenCode-Team** und keinerlei Zugehörigkeitsverhältnis. Das ursprüngliche Projekt wurde vom opencode-Team unter der MIT-Lizenz veröffentlicht. Dieser Fork behält die Upstream-MIT-Lizenz bei und fügt mehrere selbst entwickelte Module hinzu (siehe [NOTICE](./NOTICE)).

## Einleitung

Dieses Projekt ist eine **modifizierte und erweiterte Version** des offiziellen opencode, mit den Zielen:

- 🔧 **Behebung von Problemen mit chinesischen Sprachmerkmalen**: Debuggen von Kompatibilitätsproblemen im Upstream bei der chinesischen Wortsegmentierung, CJK-Zeichenverarbeitung, Vollbreitenzeichen, chinesischen Pfaden und chinesischen Eingabemethoden (siehe [Liste der Korrekturen für chinesische Sprachmerkmale](./docs/localization/zh-hans-fixes.md))
- 🧩 **Produktionstaugliche DAG-Workflow-Engine**: Selbst entwickeltes [Harness-DAG-Workflow](./docs/harness-dag.md), das es einem LLM-Agenten ermöglicht, komplexe parallele Aufgaben in einer Sitzung zu orchestrieren und auszuführen.
- 🎯 **Erhalt der Upstream-Kompatibilität**: Der gesamte unter MIT-Lizenz stehende Upstream-Code bleibt unverändert, Builds werden nicht beeinträchtigt und die Upstream-API nicht verändert.

## Installation

```bash
# Direktinstallation (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Paketmanager
npm i -g opencode-ai@latest        # auch mit bun/pnpm/yarn möglich
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS und Linux (empfohlen, immer aktuell)
brew install opencode              # macOS und Linux (offizielle brew formula, weniger häufige Updates)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # beliebiges System
nix run nixpkgs#opencode           # oder github:anomalyco/opencode für den neuesten dev-Branch
```

> [!TIP]
> Entfernen Sie vor der Installation bitte ältere Versionen vor 0.1.x.

## Für diesen Zweig spezifische Merkmale

Dieser Zweig baut auf dem Upstream opencode auf und **fügt** folgende Fähigkeiten **hinzu** oder **verbessert sie erheblich** (Details siehe jeweiliger Abschnitt):

| Merkmal | Kurzbeschreibung | Lizenz |
|------|------|------|
| 🧩 DAG HARNESS Orchestrierungs-Aufgabensystem | Ermöglicht es einem LLM-Agenten, in einer einzigen Sitzung einen mehrknotigen parallelen Workflow zu orchestrieren | AGPL-3.0 |
| 🪝 HOOKS API Superset-Implementierung | Vollständiges Hooks-System mit 22 Laufzeitereignissen × 5 Ausführungstypen | MIT + Branch-Erweiterungen |
| 🛡️ Leichtgewichtiger CODING-Isolationsraum | Sandbox + Worktree duale isolierte Ausführungsumgebung | MIT + Branch-Erweiterungen |
| 🔧 Fehlerbehebungen für chinesische Funktionen | CJK-Segmentierung / Vollbreitensatzzeichen / IME-Kompatibilität / Chinesische Pfade | MIT |
| 🔬 Weitere kleine Fehlerbehebungen | Kopieren & Einfügen, ostasiatische Zeichenbreite, Abbruch chinesischer Ausgaben usw. | MIT |

### 🧩 DAG HARNESS Orchestrierungs-Aufgabensystem (Eigenentwickeltes Modul · AGPL-3.0)

Früher als Harness-DAG-Workflow bekannt. Eine produktionsreife **DAG (Directed Acyclic Graph)-Workflow-Engine**, die es einem LLM-Agenten ermöglicht, komplexe parallele Aufgaben in einer einzigen Sitzung zu orchestrieren. Kernfunktionen:

- **Automatische Planung**: Spawnt Unteragenten basierend auf Knotenabhängigkeiten automatisch und führt sie parallel aus
- **Dynamische Neuplanung**: Ermöglicht das Live-Replanen des Workflows während der Ausführung (Hinzufügen, Entfernen, Ändern von Knoten, Anpassen der Parallelitätsgrenze)
- **Strikte Compliance**: Zustandsautomat nicht umgehbar, Endzustände irreversibel, Ereignisse werden immer übermittelt, Priorität auf Persistenz
- **Slash-Befehl-Integration**: Steuerung über `/dag-ctl`, Workflow-Konfiguration mit `/dag-worker`
- **Persistente Auditierung**: SQLite-Schema mit 6 Tabellen, alle Zustandsänderungen nachvollziehbar

Vollständige Architekturdokumentation siehe [Harness-DAG-Workflow-Dokumentation](./docs/harness-dag.md), Entwicklerleitfaden siehe [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Lizenz**: Dieses Modul ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) sowie zugehörige Vorlagen und Dokumentation) wird unter der **GNU AGPL v3** veröffentlicht – bei Nutzung müssen alle Änderungen offengelegt werden. Siehe [NOTICE](./NOTICE) und [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 HOOKS API Superset-Implementierung

Dieser Zweig bewahrt und erweitert das Upstream-Hooks-API-System vollständig:

- **22 Laufzeit-Auslöseereignisse**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 Ausführungstypen**: `command` (Shell) / `mcp` (MCP-Tool) / `http` (REST) / `prompt` (einzelne LLM-Runde) / `agent` (mehrere LLM-Runden)
- **stdin/stdout JSON-Umschlag-Kommunikationsprotokoll**: Vollständige Protokolldokumentation siehe [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Erweiterungen dieses Zweigs**: DAG-Workflow-Ereignisbus-Integration (`workflow.*` / `node.*` Ereignisse) + TUI-Abonnement + HTTP-API-Weiterleitung

### 🛡️ Leichtgewichtiger CODING-Isolationsraum

Dieser Zweig bietet eine zweigleisige isolierte Ausführungsumgebung, mit der Agenten/Benutzer Code in einer sicheren Sandbox ausprobieren können, ohne das reale Repository zu beeinträchtigen:

| Isolationsstufe | Mechanismus | Verwendungszweck |
|---------|------|------|
| **Sandbox** (leichtgewichtig) | Temporäres Verzeichnis + LSP-Diagnose + mehrsprachige Toolchain (Python/Node/TS/Go/Rust/C/C++) | Testausführung für einzelne Dateien / kleine Experimente |
| **Worktree** (schwergewichtig) | `git worktree` unabhängiger Zweig + unabhängige Dateisystem-Ansicht | Paralleles Bearbeiten durch mehrere Agenten, große Refaktorisierungen |

- 📦 **Sandbox-Werkzeug**: `packages/opencode/src/tool/sandbox.ts`, jede Sandbox hat einen eigenen Abhängigkeitscache (venv / node_modules), unterstützt den `ephemeral`-Modus (einmalig) und den `background`-Modus für asynchrone Langzeitaufgaben.
- 🌳 **DAG Worktree-Manager**: In DAG-Workflows kann jeder parallele Knoten automatisch einem unabhängigen Worktree-Zweig zugewiesen werden; nach Abschluss des Knotens wird mittels `git merge` in den Hauptzweig integriert.

### 🔧 Fehlerbehebungen für chinesische Funktionen (Behobene Upstream-Probleme)

Es wurden mehrere Kompatibilitäts-/Erfahrungsprobleme, die in chinesischen Nutzungsszenarien der Upstream-Version auftraten, behoben und optimiert. Abgedeckt werden:

- **Chinesische Segmentierung und Token-Zählung**: Fehlerbehandlung bei CJK-Zeichen in bestimmten Tokenizern
- **Vollbreitensatzzeichen-Kompatibilität**: Toleranz gegenüber Vollbreiten-Doppelpunkten, Anführungszeichen, Klammern bei der Konfigurationsanalyse
- **Chinesische Pfadbehandlung**: Korrekte Übergabe von Dateipfaden mit Leerzeichen und CJK-Zeichen in Hooks/Sandbox
- **Kompatibilität mit chinesischen Eingabemethoden (IME)**: Eingabeverzögerung und Cursor-Flackern im TUI bei IME-Kandidatenfenstern

Detaillierte Behebungsprotokolle und Regressionstests siehe [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Falls Sie weitere Probleme bei chinesischen Funktionen feststellen, reichen Sie bitte die Schritte zur Reproduktion im [Issues-Bereich](./issues) ein. Ich werde sie weiterhin beheben.

### 🔬 Weitere kleine Fehlerbehebungen (Integrierte Upstream-Korrekturen)

Dieser Zweig enthält vollständig die Upstream-Korrekturen für mehrere kleinere Erfahrungsprobleme, die durch Regressionstests verifiziert wurden:

| Problem | Upstream-Fix-Commit | Auswirkungsbereich |
|------|-----------------|----------|
| 📋 **Beschädigung beim Kopieren & Einfügen** – Eingefügte Prompt-Inhalte des Benutzers wurden im TUI fälschlich abgeschnitten oder Zeichen gingen verloren | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI-Eingabeerfahrung |
| 📐 **Layout wird nach Einfügen nicht aktualisiert** – Nach dem Einfügen langer Texte dehnte sich die Höhe des Prompt-Feldes nicht automatisch aus, was zu einem abgeschnittenen visuellen Eindruck führte | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI-Eingabeerfahrung |
| 📎 **Kein Fallback bei fehlgeschlagenem Schreiben in die Zwischenablage** – Bei einem Fehlschlag der `navigator.clipboard` API (z. B. in HTTP-Umgebungen) führte das Kopieren direkt zu einem Fehler | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Browserübergreifende Kompatibilität |
| 🎨 **Unzureichender Vordergrund-Kontrast des Einfüge-Badges** – Der Text des Einfüge-Übersichts-Badges war in bestimmten Themes schwer lesbar | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI-Visuelles Erlebnis |
| 📏 **CJK / Ostasiatische Zeichenbreitenschätzung** – Die Anzeigebreite von Emoji, Vollbreitenzeichen, chinesischen Zeichen und anderen ostasiatischen Breitenzeichen stimmte nicht mit dem tatsächlichen Platzbedarf überein, was zu Cursor-Verschiebungen führte | Wurde in das Fehlerbehebungssystem für die CJK-Segmentierung integriert | TUI-Zeichenausrichtung |
| ⌨️ **Flackern des IME-Kandidatenfensters** – Bei aktivierter chinesischer/japanischer Eingabemethode flackerte der Cursor und Zeichen wurden verzögert eingefügt | Lokaler Workaround-Patch | TUI-Eingabeerfahrung |

> Dieser Zweig erfindet das Rad nicht neu: Bereits upstream behobene Probleme werden durch Synchronisation mit dem `stable`-Branch aktualisiert; dieser Zweig behebt hauptsächlich noch nicht upstream behandelte Probleme mit chinesischen Funktionen / DAG-Workflow.

## Vom Upstream beibehaltene Funktionen

Die folgenden Funktionen stammen vollständig aus dem Upstream opencode (MIT-Lizenz) und wurden in diesem Fork nicht funktional verändert:

### Desktop-Anwendung (BETA)

OpenCode stellt auch eine Desktop-Version zur Verfügung. Diese kann direkt von der [Releases-Seite](https://github.com/anomalyco/opencode/releases) oder von [opencode.ai/download](https://opencode.ai/download) heruntergeladen werden.

| Plattform             | Download-Datei                        |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` oder AppImage          |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agents

OpenCode enthält zwei integrierte Agenten, zwischen denen mit der `Tab`-Taste schnell gewechselt werden kann:

- **build** – Standardmodus mit vollständigen Berechtigungen, geeignet für Entwicklungsarbeiten
- **plan** – Nur-Lese-Modus, geeignet für Codeanalyse und Exploration
  - Dateiänderungen werden standardmäßig abgelehnt.
  - Vor der Ausführung von bash-Befehlen wird um Bestätigung gebeten.
  - Nützlich zum Untersuchen unbekannter Codebasen oder zur Planung von Änderungen.

Zusätzlich gibt es einen **general**-Subagenten für komplexe Suchvorgänge und mehrstufige Aufgaben. Dieser wird intern verwendet, kann aber auch durch Eingabe von `@general` in Nachrichten aufgerufen werden.

Weitere Informationen zu [Agents](https://opencode.ai/docs/agents).

### ClaudeCode Hooks API-Superset-Implementierung

Dieser Fork behält das gesamte Hooks-API-System und die 22 zur Laufzeit auslösbaren Ereignisse des Upstreams bei. Hooks werden in der Konfigurationsdatei im `hooks`-Feld unter ihrem Ereignisnamen registriert und unterstützen die fünf Ausführungstypen `command`, `mcp`, `http`, `prompt` und `agent`. Die Kommunikation erfolgt über JSON-Hüllen auf stdin/stdout. Das vollständige Protokoll finden Sie unter [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

Eine detaillierte Liste der Ereignisse und Ausführungstypen finden Sie im [beibehaltenen Originalabschnitt der README](./docs/readmes/upstream-features.md).

## Lizenz und Urheberschaft

Dieses Repository verwendet ein **hybrides Lizenzmodell**:

| Inhalt | Lizenz | Ort |
|--------|--------|-----|
| Upstream-opencode-Code (meiste Dateien) | **MIT** | Siehe [`LICENSE`](./LICENSE) |
| Selbst entwickelte DAG-Workflow-Engine (`packages/opencode/src/dag/` sowie zugehörige Tools, Vorlagen und Dokumentation) | **GNU AGPL v3** | Siehe [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Die vollständige Abgrenzungsbeschreibung finden Sie in der Datei [`NOTICE`](./NOTICE).

### 🔒 AGPL v3 verbindliche Lizenzbestimmung (harte Bedingung für diesen Branch)

**Die Richtlinien des Autors dieses Projekts für die Weiterentwicklung dieses Repositorys:**

1. **Selbst entwickelter Code muss unter GNU AGPL v3 stehen** – Jeglicher Code, der vom Autor dieses Branches neu hinzugefügt, neu geschrieben oder wesentlich verändert wurde, **muss** unter der GNU Affero General Public License v3 oder höher (AGPL-3.0-or-later) lizenziert sein.
2. **Ansteckende Wirkung der AGPL** – Jedes Projekt, das AGPL-3.0-Module (wie die DAG-Workflow-Engine) verwendet, modifiziert oder davon ableitet, **muss seinen vollständigen Quellcode unter AGPL-3.0 offenlegen** und Endbenutzern den Zugriff darauf gewähren.
3. **SaaS-Zwangsoffenlegung** – Wenn Sie dieses Projekt oder abgeleitete Werke als Netzwerkdienst (SaaS / Cloud-Plattform) bereitstellen, **müssen Sie allen Nutzern dieses Dienstes einen Link zum Download des vollständigen Quellcodes zur Verfügung stellen** (dies ist die Kernbestimmung der AGPL im Unterschied zur GPL, §13).
4. **Namensnennung** – Die Original-Urheberangaben, Urheberrechtsvermerke und die Zuschreibungsinformationen in der NOTICE-Datei müssen beibehalten werden.

> ⚖️ **Warum AGPL?** Der Autor ist der Ansicht, dass der Wert von Open-Source-Software in fortlaufender Zusammenarbeit liegt. Die AGPL verhindert die Schädigung der Open-Source-Community durch die „Closed-Source-SaaSifizierung" – jede kommerzielle Nutzung, die von diesem Projekt profitiert, muss der Gemeinschaft etwas zurückgeben.

**Die unter MIT lizenzierten Teile sind nicht an diese Bedingungen gebunden** und unterliegen allein der Kontrolle des Upstream-opencode-Teams.

### Beziehung zum ursprünglichen opencode-Team

- ✅ Dieses Projekt **basiert auf** dem Upstream-Code von [opencode](https://github.com/sst/opencode).
- ❌ Dieses Projekt steht in **keinerlei Zugehörigkeits- oder Autorisierungsverhältnis** zum offiziellen opencode-Team (sst / anomalyco).
- ❌ Dieses Projekt ist keine offizielle Veröffentlichung von opencode und bietet keine Unterstützungszusagen für den Upstream.
- ❌ **Das offizielle OpenCode-Team leistet keinerlei technischen Support, Garantie oder Billigung für diesen Branch** (gemäß der klaren Zuschreibungsanforderung im Upstream-README).
- ✅ Die Verbesserungen dieses Projekts, wie die DAG-Workflow-Engine, die Fehlerbehebungen für chinesische Funktionen (CJK-DEBUG) und andere Erweiterungen, werden unabhängig vom Autor gepflegt.
- ✅ Die Urheberschaft des Upstream-MIT-Codes bleibt vollständig erhalten, ohne dass die Autoren- und Urheberrechtsvermerke verfälscht wurden.

Wenn Sie die offizielle Version von opencode verwenden möchten, besuchen Sie bitte https://opencode.ai oder https://github.com/sst/opencode.

## Dokumentationsindex

- [`docs/harness-dag.md`](./docs/harness-dag.md) – Vollständige Harness-DAG-Workflow-Dokumentation
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) – Liste der Korrekturen für chinesische Sprachmerkmale
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) – Beibehaltene Upstream-opencode-Funktionen
- [`NOTICE`](./NOTICE) – Lizenzabgrenzung und Urheberschaftserklärung
- [`AGENTS.md`](./AGENTS.md) – Leitfaden für Weiterentwicklung und Beiträge

## Mitwirken

Wenn Sie Code beitragen möchten, lesen Sie bitte [`CONTRIBUTING.md`](./CONTRIBUTING.md), bevor Sie einen Pull Request einreichen.

### Entwicklung auf Basis dieses Forks

Wenn Sie „opencode“ im Projektnamen verwenden (z. B. „opencode-dashboard“ oder „opencode-mobile“), geben Sie bitte in der README an, dass das Projekt weder vom OpenCode-Team offiziell entwickelt wurde noch mit dem Autor dieses Forks in Verbindung steht.

## Häufig gestellte Fragen (FAQ)

### Was unterscheidet dies von Claude Code?

Funktionell sehr ähnlich, die wesentlichen Unterschiede sind:

- 100% Open Source
- Keine Bindung an einen bestimmten Anbieter. Die Modelle von [OpenCode Zen](https://opencode.ai/zen) werden empfohlen, es können aber auch Claude, OpenAI, Google oder sogar lokale Modelle verwendet werden.
- Integrierte LSP-Unterstützung
- Fokus auf Terminal-Oberfläche (TUI)
- Client/Server-Architektur. Kann lokal ausgeführt und gleichzeitig über ein Mobilgerät ferngesteuert werden.

### Was unterscheidet dies von der offiziellen opencode-Version?

- Neue Harness-DAG-Workflow-Engine (AGPL-3.0)
- Fortlaufende Debugs von Kompatibilitätsproblemen bei der Verwendung mit Chinesisch
- Langfristig unabhängig gepflegt, vom Upstream-Rhythmus entkoppelt

## Community

- 📖 [Upstream opencode Community](https://opencode.ai)
- 📝 [Issue-Bereich dieses Forks](./issues) (für Feedback zu Problemen und neue Feature-Vorschläge)