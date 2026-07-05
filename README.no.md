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
  <a href="./README.no.md"><b>Norsk</b></a> ·
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

> **En forbedret fork av [opencode](https://github.com/anomalyco/opencode) med en produksjonsklar DAG-arbeidsflytmotor for multi-agent-orchestrering.**

Bygger på toppen av den MIT-lisensierte [opencode](https://github.com/anomalyco/opencode) terminal-AI-agenten. **Ikke tilknyttet eller støttet av OpenCode-teamet.**

---

## Grenstatus

| Gren | Base | Innhold | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Verktøyoptimering | ✅ **Stabil** |
| **`dag-branch`** | main + DAG | DAG-arbeidsflytmotor (114 filer) | 🔧 **Under utvikling** — tilpasning til v1.17.11-API-er |

> [!IMPORTANT]
> **DAG-arbeidsflytmotoren blir for tiden portert** fra v1.15.10 til v1.17.11-kodebasen.
> Den ligger på `dag-branch` og er **ikke funksjonell ennå**. `main`-grenen er fullt brukbar
> med Hooks, Goal Auto-Loop og verktøyunntakshåndtering — alt produksjonsklart.

---

## Hva som gjør denne forken anderledes

### 📌 Stabil på `main`

#### Hooks-API (26 events × 5 utførelsestyper)

Full kompatibilitet med Claude Code-hooks-protokollen: `command`, `mcp`, `http`, `prompt`, `agent` hook-typer med 26 hook-events inkludert `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` og flere. Hooks lastes fra en global / prosjekt / worktree `hooks.json`-kjede, eller kan registreres per økt ved kjøretid over HTTP-API-en; valgfri workspace-trust-gating (`requireTrust` + `/trust`-kommandoen) begrenser hook-utførelse til kataloger du har godkjent.

Se [hooks-referanse](./packages/core/src/plugin/skill/configure-hooks.md).

#### Goal Auto-Loop

En autonom agent-løkke som kontinuerlig styrer en agent mot et brukerdefinert mål. En LLM-dommer avgjør etter hver tur om målet er nådd eller trenger flere turer, innen et konfigurerbart turbudsjett. `/goal <mål>` for å sette, `/subgoal` for å legge til delmål, `/goal resume` for å fortsette et pauset mål.

#### Verktøyunntakshåndtering

- **JSON-reparasjon**: `safeParseJson` + `fixJsonUnicodeEscapes` — reparerer ødelagte multi-byte Unicode-escapes i LLM-generert JSON
- **Validering av Question-verktøy**: strukturert feilformatering med felt-nivå-hint og eksempler på korrekte kall
- **Verktøybeskrivelser**: utvidede `.txt`-dokumenter for `question`, `task`, `skill`, `webfetch`, `websearch` med Parameter- og Returns-seksjoner
- **Shell-pipe-rettelse**: `stdout/stderr: "pipe"` på alle `ChildProcess.make`-kall + yndig tømming av reader-fiber

### 🔧 Under utvikling på `dag-branch`

#### DAG-arbeidsflytmotor (AGPL-3.0)

En **rettet asyklisk graf (DAG) arbeidsflytmotor** som lar LLM-agenter orkestrere komplekse multi-node parallelle oppgaver innen en enkelt økt.

> ⚠️ **Status**: Rå-kopiert fra v1.15.10-forken (114 filer). 217 typefeil venter på API-tilpasning (synkron `Database.use` → Effect-basert `Database.Service`, `Bus` → `EventV2Bridge` osv.). Ikke kompilerbar ennå.

| Evne | Beskrivelse |
|---|---|
| **Automatisk planlegging** | Starter barn-agenter basert på avhengighetsrekkefølge, parallelt der det er mulig |
| **Dynamisk omlanlegging** | Legg til/fjern/oppdater noder og juster samtidighet under kjøring |
| **Tilstandsmaskin-integritet** | Fire jerneregler: omgåelse av tilstandsmaskin forbudt, terminaltilstander irreversible, events må kringkastes, persistér før mutér |
| **Terminal-TUI** | Fullt DAG-kontrollpanel med blokktegn-topologikart, trevisning, node-dialoger, sanntidsoppdateringer |
| **Kræsj-gjenoppretting** | Detekterer og gjenopptar foreldreløse kjørende arbeidsflyter ved omstart |
| **Betinget forgrening** | Noder kan betinget utføre eller hoppe over basert på oppstrøms-output |
| **Sub-DAG-nesing** | Worker-typen `dag` skaper rekursive sub-arbeidsflyter (maks dybde 3) |
| **Vedvarende revisjon** | 6-tabellers SQLite-skjema, alle tilstandsoverganger sporbare |

### CJK- og lokaliseringsrettelser

Omfattende rettelser for håndtering av kinesisk/japansk/koreansk tekst: tokenisering, helbred skilletegn, filstier, IME-input i terminal-UI-et. Se [liste over rettelser](./docs/localization/zh-hans-fixes.md).

### Dobbelt isolasjon: Sandbox + Worktree

- **Sandbox** — midlertidige mapper med LSP-diagnostikk for trygge kode-eksperimenter
- **Worktree** — `git worktree`-isolasjon per arbeidsflyt for parallell multi-agent-redigering

---

## Installasjon

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før installasjon.

---

## Behold upstream — og mer

Alle upstream MIT-lisensierte funksjoner er fullt bevart:

- **Skrivebords-app** (macOS / Windows / Linux) — last ned fra [releases](https://github.com/anomalyco/opencode/releases)
- **Build- & Plan-agenter** — `Tab` for å bytte mellom full-tilgangs- og les-kun-moduser
- **Multi-tilbyder** — Claude, OpenAI, Google, lokale modeller via [OpenCode Zen](https://opencode.ai/zen)
- **Innebygd LSP** — sanntids-diagnostikk fra språkservere
- **Client/server-arkitektur** — kjør lokalt, styr eksternt fra mobil

Denne forken legger DAG-motoren, CJK-rettelser, sandbox-kodearbeidsområde og mål-tracking på toppen — uten å ødelegge noe.

---

## Lisens

Dette repositoriet bruker en **blandet lisensmodell**:

| Innhold | Lisens | Plassering |
|---------|---------|----------|
| Upstream opencode-kode (det store flertallet) | **MIT** | [`LICENSE`](./LICENSE) |
| Selvutviklet DAG-arbeidsflytmotor | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Fulle grensedetaljer i [`NOTICE`](./NOTICE).

> ⚖️ **Hvorfor AGPL?** DAG-motoren er det sentrale differensierte arbeidet. AGPL sikrer at enhver avledning — inkludert SaaS-distribusjoner — må gi tilbake.

---

## Dokumentasjon

- [`docs/harness-dag.md`](./docs/harness-dag.md) — DAG-motor-arkitektur & bruk
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — CJK-rettelses-katalog
- [`NOTICE`](./NOTICE) — lisensgrenser & kreditering
- [`AGENTS.md`](./AGENTS.md) — bidrags- & utviklingsguide

## Fellesskap

- 📖 [Upstream opencode-fellesskap](https://opencode.ai)
- 📝 [Fork-issue-tracker](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
