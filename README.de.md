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
  <a href="./README.de.md"><b>Deutsch</b></a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.it.md">Italiano</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.no.md">Norsk</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.uk.md">Українська</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.gr.md">Ελληνικά</a> ·
  <a href="./README.bn.md">বাংলা</a>
</p>

# OpenCode-DAG

> **Ein erweiterter Fork von [opencode](https://github.com/anomalyco/opencode) mit einer produktionsreifen DAG-Workflow-Engine für Multi-Agenten-Orchestrierung.**

Baut auf dem MIT-lizenzierten [opencode](https://github.com/anomalyco/opencode) Terminal-AI-Agenten auf. **Nicht offiziell verbunden mit oder unterstützt vom OpenCode-Team.**

---

## Branch-Status

| Branch | Basis | Inhalt | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Tools-Optimierung | ✅ **Stabil** |
| **`dag-branch`** | main + DAG | DAG-Workflow-Engine (114 Dateien) | 🔧 **In Entwicklung** — Anpassung an v1.17.11-APIs |

> [!IMPORTANT]
> Die **DAG-Workflow-Engine wird derzeit portiert** von v1.15.10 in die v1.17.11-Codebasis.
> Sie befindet sich auf dem `dag-branch` und ist **noch nicht funktionsfähig**. Der `main`-Branch ist vollständig nutzbar
> mit Hooks, Goal-Auto-Loop und Tools-Ausnahmebehandlung — alles produktionsreif.

---

## Was diesen Fork anders macht

### 📌 Stabil auf `main`

#### Hooks-API (26 Events × 5 Ausführungstypen)

Volle Kompatibilität mit dem Claude-Code-Hooks-Protokoll: `command`, `mcp`, `http`, `prompt`, `agent` Hook-Typen mit 26 Hook-Events, darunter `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` und weitere. Hooks werden aus einer globalen / Projekt- / Worktree-`hooks.json`-Kette geladen oder können pro Sitzung zur Laufzeit über die HTTP-API registriert werden; optionale Workspace-Trust-Prüfung (`requireTrust` + der `/trust`-Befehl) beschränkt die Hook-Ausführung auf von dir freigegebene Verzeichnisse.

Siehe [Hooks-Referenz](./packages/core/src/plugin/skill/configure-hooks.md).

#### Goal-Auto-Loop

Eine autonome Agenten-Schleife, die einen Agenten kontinuierlich in Richtung eines benutzerdefinierten Ziels steuert. Ein LLM-Judge entscheidet nach jedem Durchlauf, ob das Ziel erreicht ist oder weitere Durchläufe benötigt, innerhalb eines konfigurierbaren Durchlauf-Budgets. `/goal <Ziel>` zum Setzen, `/subgoal` zum Hinzufügen von Teilzielen, `/goal resume` zum Fortsetzen eines pausierten Ziels.

#### Tool-Ausnahmebehandlung

- **JSON-Reparatur**: `safeParseJson` + `fixJsonUnicodeEscapes` — repariert defekte Multi-Byte-Unicode-Escapes in LLM-generiertem JSON
- **Validierung des Question-Tools**: strukturierte Fehlerformatierung mit Feld-Ebenen-Hinweisen und Beispielen für korrekte Aufrufe
- **Tool-Beschreibungen**: erweiterte `.txt`-Dokumente für `question`, `task`, `skill`, `webfetch`, `websearch` mit Parameter- und Rückgabe-Abschnitten
- **Shell-Pipe-Fix**: `stdout/stderr: "pipe"` bei allen `ChildProcess.make`-Aufrufen + ordnungsgemäßes Entleeren des Reader-Fibers

### 🔧 In Entwicklung auf `dag-branch`

#### DAG-Workflow-Engine (AGPL-3.0)

Eine **gerichtete azyklische Graphen-Engine (DAG)**, die es LLM-Agenten ermöglicht, komplexe parallele Multi-Knoten-Aufgaben innerhalb einer einzigen Sitzung zu orchestrieren.

> ⚠️ **Status**: Roh-kopiert vom v1.15.10-Fork (114 Dateien). 217 Typfehler stehen zur API-Anpassung aus (Sync `Database.use` → Effect-basiert `Database.Service`, `Bus` → `EventV2Bridge` usw.). Noch nicht kompilierbar.

| Funktion | Beschreibung |
|---|---|
| **Automatische Terminplanung** | Startet Kind-Agenten basierend auf der Abhängigkeitsreihenfolge, parallel wo möglich |
| **Dynamische Umplanung** | Knoten hinzufügen/entfernen/aktualisieren und Parallelität während des Laufs anpassen |
| **Zustandsautomaten-Integrität** | Vier eiserne Regeln: Umgehung des Zustandsautomaten verboten, Endzustände irreversibel, Events müssen broadcasten, persistieren vor Mutieren |
| **Terminal-TUI** | Vollständiges DAG-Kontrollpanel mit Blockzeichen-Topologie-Karte, Baumansicht, Knoten-Dialogen, Echtzeit-Updates |
| **Absturz-Wiederherstellung** | Erkennt verwaiste laufende Workflows beim Neustart und setzt sie fort |
| **Bedingte Verzweigung** | Knoten können bedingt ausführen oder überspringen, basierend auf Upstream-Ausgabe |
| **Sub-DAG-Verschachtelung** | Worker-Typ `dag` erzeugt rekursive Sub-Workflows (max Tiefe 3) |
| **Persistente Auditierung** | 6-Tabellen-SQLite-Schema, alle Zustandsübergänge nachverfolgbar |

### CJK- & Lokalisierungs-Fixes

Umfassende Fixes für die Verarbeitung von chinesischem/japanischem/koreanischem Text: Tokenisierung, vollbreite Satzzeichen, Dateipfade, IME-Eingabe im Terminal-UI. Siehe [Fixes-Liste](./docs/localization/zh-hans-fixes.md).

### Duale Isolierung: Sandbox + Worktree

- **Sandbox** — temporäre Verzeichnisse mit LSP-Diagnostik für sichere Code-Experimente
- **Worktree** — `git worktree`-Isolierung pro Workflow für paralleles Multi-Agenten-Bearbeiten

---

## Installation

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Entferne Versionen älter als 0.1.x vor der Installation.

---

## Upstream bleibt erhalten — und mehr

Alle Upstream-Fähigkeiten unter MIT-Lizenz bleiben vollständig erhalten:

- **Desktop-App** (macOS / Windows / Linux) — Download von [Releases](https://github.com/anomalyco/opencode/releases)
- **Build- & Plan-Agenten** — `Tab` zum Wechseln zwischen Vollzugriffs- und Nur-Lese-Modi
- **Multi-Provider** — Claude, OpenAI, Google, lokale Modelle via [OpenCode Zen](https://opencode.ai/zen)
- **Eingebautes LSP** — Echtzeit-Diagnostik von Sprachservern
- **Client/Server-Architektur** — lokal ausführen, fernsteuern vom Mobilgerät

Dieser Fork fügt die DAG-Engine, CJK-Fixes, die Sandbox-Coding-Workbench und das Goal-Tracking obendrauf hinzu — ohne etwas zu beschädigen.

---

## Lizenz

Dieses Repository verwendet ein **gemischtes Lizenzmodell**:

| Inhalt | Lizenz | Ort |
|---------|---------|----------|
| Upstream-opencode-Code (die große Mehrheit) | **MIT** | [`LICENSE`](./LICENSE) |
| Selbstentwickelte DAG-Workflow-Engine | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Vollständige Grenzdetails in [`NOTICE`](./NOTICE).

> ⚖️ **Warum AGPL?** Die DAG-Engine ist die zentrale differenzierte Arbeit. AGPL stellt sicher, dass jede Ableitung — einschließlich SaaS-Deployments — zurückgeben muss.

---

## Dokumentation

- [`docs/harness-dag.md`](./docs/harness-dag.md) — DAG-Engine-Architektur & Verwendung
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — CJK-Fixes-Katalog
- [`NOTICE`](./NOTICE) — Lizenzgrenzen & Namensnennung
- [`AGENTS.md`](./AGENTS.md) — Beitrag- & Entwicklungsleitfaden

## Community

- 📖 [Upstream-opencode-Community](https://opencode.ai)
- 📝 [Fork-Issue-Tracker](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
