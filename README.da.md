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
  <a href="./README.da.md"><b>Dansk</b></a> ·
  <a href="./README.de.md">Deutsch</a> ·
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

> **En forbedret fork af [opencode](https://github.com/anomalyco/opencode) med en produktionsklar DAG-workflow-motor til multi-agent-orchestrering.**

Bygger oven på den MIT-licenserede [opencode](https://github.com/anomalyco/opencode) terminal-AI-agent. **Ikke tilknyttet eller støttet af OpenCode-teamet.**

---

## Branch-status

| Branch | Basis | Indhold | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Tools-optimering | ✅ **Stabil** |
| **`dag-branch`** | main + DAG | DAG-workflow-motor (114 filer) | 🔧 **Under udvikling** — tilpasning til v1.17.11-API'er |

> [!IMPORTANT]
> **DAG-workflow-motoren bliver i øjeblikket porteret** fra v1.15.10 til v1.17.11-kodebasen.
> Den lever på `dag-branch` og er **endnu ikke funktionel**. `main`-branchen er fuldt brugbar
> med Hooks, Goal Auto-Loop og Tools-undtagelseshåndtering — alt produktionsklart.

---

## Hvad der gør denne fork anderledes

### 📌 Stabil på `main`

#### Hooks-API (26 events × 5 udførelsestyper)

Fuld kompatibilitet med Claude Code-hooks-protokollen: `command`, `mcp`, `http`, `prompt`, `agent` hook-typer med 26 hook-events herunder `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` og flere. Hooks indlæses fra en global / projekt / worktree `hooks.json`-kæde, eller kan registreres pr. session ved kørselstidspunkt over HTTP-API'en; valgfri workspace-trust-gating (`requireTrust` + `/trust`-kommandoen) begrænser hook-udførelse til mapper, du har godkendt.

Se [hooks-reference](./packages/core/src/plugin/skill/configure-hooks.md).

#### Goal Auto-Loop

En autonom agent-løkke, der kontinuerligt styrer en agent mod et brugerdefineret mål. En LLM-dommer beslutter efter hver tur, om målet er nået, eller om der er brug for flere ture, inden for et konfigurerbart turbudget. `/goal <mål>` for at sætte, `/subgoal` for at tilføje delmål, `/goal resume` for at fortsætte et pauset mål.

#### Tools-undtagelseshåndtering

- **JSON-reparation**: `safeParseJson` + `fixJsonUnicodeEscapes` — reparerer ødelagte multi-byte Unicode-escapes i LLM-genereret JSON
- **Validering af Question-værktøj**: struktureret fejlformatering med felt-niveau-hints og eksempler på korrekte kald
- **Værktøjsbeskrivelser**: udvidede `.txt`-dokumenter for `question`, `task`, `skill`, `webfetch`, `websearch` med Parameter- og Returns-sektioner
- **Shell-pipe-rettelse**: `stdout/stderr: "pipe"` på alle `ChildProcess.make`-kald + yndefuld tømning af reader-fiber

### 🔧 Under udvikling på `dag-branch`

#### DAG-workflow-motor (AGPL-3.0)

En **rettet acyklisk graf (DAG) workflow-motor**, der lader LLM-agenter orkestrere komplekse multi-node parallelle opgaver inden for en enkelt session.

> ⚠️ **Status**: Rå-kopieret fra v1.15.10-forken (114 filer). 217 typefejl afventer API-tilpasning (synkron `Database.use` → Effect-baseret `Database.Service`, `Bus` → `EventV2Bridge` osv.). Endnu ikke kompilerbar.

| Evne | Beskrivelse |
|---|---|
| **Automatisk planlægning** | Starter barn-agenter baseret på afhængighedsrækkefølge, parallelt hvor muligt |
| **Dynamisk omplanlægning** | Tilføj/fjern/opdater noder og juster samtidighed under kørsel |
| **Tilstandsmaskine-integritet** | Fire jernregler: omgåelse af tilstandsmaskine forbudt, terminaltilstande irreversible, events skal broadcasts, persistér før mutér |
| **Terminal-TUI** | Fuld DAG-kontrolpanel med bloktegn-topologikort, trævisning, node-dialoger, realtidsopdateringer |
| **Nedbrudsgendannelse** | Detekterer og genoptager forældreløse kørende workflows ved genstart |
| **Betinget forgrening** | Noder kan betinget udføre eller springe over baseret på upstream-output |
| **Sub-DAG-indlejring** | Worker-typen `dag` skaber rekursive sub-workflows (maks dybde 3) |
| **Vedvarende revision** | 6-tabels SQLite-skema, alle tilstandsovergange sporbare |

### CJK- og lokaliseringsrettelser

Omfattende rettelser for håndtering af kinesisk/japansk/koreansk tekst: tokenisering, fuldbredde tegnsætning, filstier, IME-input i terminal-UI'et. Se [liste over rettelser](./docs/localization/zh-hans-fixes.md).

### Dobbelt isolation: Sandbox + Worktree

- **Sandbox** — midlertidige mapper med LSP-diagnostik til sikre kode-eksperimenter
- **Worktree** — `git worktree`-isolation pr. workflow til parallelt multi-agent-redigering

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
> Fjern versioner ældre end 0.1.x før installation.

---

## Behold upstream — og mere

Alle upstream MIT-licenserede funktioner er fuldt bevaret:

- **Desktop-app** (macOS / Windows / Linux) — download fra [releases](https://github.com/anomalyco/opencode/releases)
- **Build- & Plan-agenter** — `Tab` for at skifte mellem fuld-adgangs- og læs-kun-tilstande
- **Multi-provider** — Claude, OpenAI, Google, lokale modeller via [OpenCode Zen](https://opencode.ai/zen)
- **Indbygget LSP** — realtids-diagnostik fra sprogservere
- **Client/server-arkitektur** — kør lokalt, styr eksternt fra mobil

Denne fork tilføjer DAG-motoren, CJK-rettelser, sandbox-kodearbejdsområde og mål-tracking ovenpå — uden at ødelægge noget.

---

## Licens

Dette repository bruger en **blandet licensmodel**:

| Indhold | Licens | Placering |
|---------|---------|----------|
| Upstream opencode-kode (det store flertal) | **MIT** | [`LICENSE`](./LICENSE) |
| Selvudviklet DAG-workflow-motor | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Fulde grænsedetaljer i [`NOTICE`](./NOTICE).

> ⚖️ **Hvorfor AGPL?** DAG-motoren er det centrale differentierede arbejde. AGPL sikrer, at enhver afledt version — inklusive SaaS-udrulninger — skal give tilbage.

---

## Dokumentation

- [`docs/harness-dag.md`](./docs/harness-dag.md) — DAG-motor-arkitektur & brug
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — CJK-rettelses-katalog
- [`NOTICE`](./NOTICE) — licensgrænser & kreditering
- [`AGENTS.md`](./AGENTS.md) — bidrags- & udviklingsguide

## Fællesskab

- 📖 [Upstream opencode-fællesskab](https://opencode.ai)
- 📝 [Fork-issue-tracker](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
