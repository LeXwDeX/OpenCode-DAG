<!--
**Machine Translation Notice**
This document was machine-translated from Chinese (zh-CN) to Dansk using DeepSeek v4 Pro.
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
  <a href="./README_DA.md"><b>Dansk</b></a> ·
  <a href="./README_DE.md">Deutsch</a> ·
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

# OpenCode (Enhanced Edition)

> **⚠️ Erklæring**: Dette projekt er en optimeret fork af [opencode](https://github.com/sst/opencode), vedligeholdt af en uafhængig udvikler på grundlag af originalversionen. Dette projekt er **ikke relateret til det officielle OpenCode-team** og har ingen tilknytningsforhold. Originalprojektet er udgivet af opencode-teamet under MIT-licens. Denne fork bevarer den oprindelige MIT-licens og tilføjer flere egenudviklede moduler (se [NOTICE](./NOTICE)).

## Introduktion

Dette projekt er en **modificeret og forbedret udgave** af opencodes officielle version med målene:

- 🔧 **Løs problemer med kinesiske tegn**: DEBUG af forskellige kompatibilitetsproblemer i upstream i forbindelse med kinesisk ordsegmentering, CJK-tegnbehandling, fuldbredde-tegnsætning, kinesiske stier og kinesiske inputmetodescenarier (se [liste over kinesiske tegnrettelser](./docs/localization/zh-hans-fixes.md))
- 🧩 **Levere en produktionsklar DAG-workflowmotor**: Egenudviklet [Harness-DAG-Workflow](./docs/harness-dag.md), som gør det muligt for en LLM-agent at orkestrere og drive parallelle opgaver med flere knudepunkter i en enkelt session
- 🎯 **Bevar upstream-kompatibilitet**: Al upstream MIT-licenseret kode forbliver uændret, uden at ødelægge eksisterende builds eller forurene upstream API'er

## Installation

```bash
# Direkte installation (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Pakkehåndtering
npm i -g opencode-ai@latest        # Kan også bruge bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS og Linux (anbefales, altid seneste)
brew install opencode              # macOS og Linux (officiel brew formula, opdateres sjældnere)
sudo pacman -S opencode            # Arch Linux (Stabil)
paru -S opencode-bin               # Arch Linux (Seneste fra AUR)
mise use -g opencode               # Ethvert system
nix run nixpkgs#opencode           # Eller brug github:anomalyco/opencode for seneste dev-gren
```

> [!TIP]
> Fjern venligst gamle versioner før 0.1.x før installation.

## Denne grens unikke funktioner

Denne gren er bygget på upstream opencode, **nye** eller **væsentligt forbedrede** funktioner er tilføjet (detaljer ses i de enkelte afsnit):

| Funktion | Kort beskrivelse | Licens |
|------|------|------|
| 🧩 DAG HARNESS orkestreringsopgavesystem | Lader LLM-agent orkestrere parallelle workflows med flere noder i en enkelt session | AGPL-3.0 |
| 🪝 HOOKS API superset-implementering | Komplet Hooks-system med 22 runtime-hændelser × 5 udførelsestyper | MIT + forbedringer i denne gren |
| 🛡️ Letvægts CODING-isolationsområde | Sandbox + Worktree dobbeltsporet isoleret udførelsesmiljø | MIT + forbedringer i denne gren |
| 🔧 Fejlretning af kinesiske funktioner | CJK-tokenisering / fuldbredde tegnsætning / IME-kompatibilitet / kinesiske stier | MIT |
| 🔬 Andre mindre fejlretninger | Kopier/indsæt, østasiatisk sprogbredde, afkortning af kinesisk output osv. | MIT |

### 🧩 DAG HARNESS orkestreringsopgavesystem (selvudviklet modul · AGPL-3.0)

Tidligere Harness-DAG-Workflow. En produktionsklar **Directed Acyclic Graph (DAG) workflow-motor**, der lader LLM-agenter orkestrere komplekse parallelle opgaver i en enkelt session. Kernefunktioner:

- **Automatisk planlægning**: Spawner automatisk underagenter baseret på nodeafhængigheder og udfører parallelt
- **Dynamisk omplanlægning**: Kan replan workflowet i realtid (tilføje, slette, ændre noder, justere samtidighedsgrænsen)
- **Jernregel-overholdelse**: Tilstandsmaskine kan ikke omgås, sluttilstande er irreversible, hændelser skal udsendes, persistens prioriteres
- **Integration af slash-kommandoer**: `/dag-ctl` styrer eksekvering, `/dag-worker` konfigurerer workflow
- **Persistent revision**: SQLite 6-tabellers skema, alle tilstandsændringer kan spores

Se [Harness-DAG-Workflow dokumentation](./docs/harness-dag.md) for den komplette arkitektur, og [AGENTS.md](./packages/opencode/src/dag/AGENTS.md) for udviklervejledning.

> **Licens**: Dette modul ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) og relaterede skabeloner og dokumentation) er udgivet under **GNU AGPL v3**-licensen — brug af modulet kræver, at alle ændringer frigives under samme licens. Se [NOTICE](./NOTICE) og [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE) for detaljer.

### 🪝 HOOKS API superset-implementering

Denne gren bevarer og forbedrer upstreams Hooks API-system fuldt ud:

- **22 runtime-hændelser**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 udførelsestyper**: `command` (shell) / `mcp` (MCP-værktøj) / `http` (REST) / `prompt` (enkelt-rund LLM) / `agent` (fler-rund LLM)
- **stdin/stdout JSON-kuvert-kommunikationsprotokol**: Se [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) for den fulde protokol.
- **Forbedringer i denne gren**: Integration af DAG workflow eventbus (`workflow.*` / `node.*` events) + TUI-abonnement + HTTP API-videresendelse

### 🛡️ Letvægts CODING-isolationsområde

Denne gren tilbyder et dobbeltsporet isoleret udførelsesmiljø, så agent/bruger kan teste kode i en sikker sandbox uden at forurene det rigtige repository:

| Isolationsniveau | Mekanisme | Anvendelsesformål |
|---------|------|------|
| **Sandbox** (letvægt) | Midlertidig mappe + LSP-diagnostik + flersprogede værktøjskæder (Python/Node/TS/Go/Rust/C/C++) | Kodetest for enkeltfiler / små eksperimenter |
| **Worktree** (tungere) | `git worktree` uafhængig gren + uafhængig filsystemvisning | Parallel redigering af flere agenter, store refaktoreringer |

- 📦 **Sandbox-værktøj**: `packages/opencode/src/tool/sandbox.ts`, hver sandbox har sin egen afhængighedscache (venv / node_modules), understøtter `ephemeral` engangstilstand og `background` asynkron længerevarende opgave.
- 🌳 **DAG Worktree-manager**: I DAG-workflowet kan hver parallel node automatisk tildeles en uafhængig worktree-gren; efter færdiggørelse flettes noden ind i hovedlinjen via `git merge`.

### 🔧 Fejlretning af kinesiske funktioner (rettet op på upstream-problemer)

Der er foretaget fejlretning og optimering af en række kompatibilitets-/brugeroplevelsesproblemer, der er fundet i upstream-versionen i kinesiske anvendelsesscenarier, dækkende:

- **Kinesisk tokenisering og token-tælling**: Håndtering af unormaliteter for CJK-tegn i visse tokenizere.
- **Kompatibilitet med fuldbredde-tegnsætning**: Tolerance for fuldbredde kolon, anførselstegn og parenteser i konfigurationsparsing.
- **Håndtering af kinesiske stier**: Korrekt videregivelse af filstier med mellemrum og CJK-tegn i hook / sandbox.
- **Kompatibilitet med kinesisk inputmetode (IME)**: TUI's inputforsinkelse og markørystelser under IME-kandidatvinduet.

 Se [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) for detaljerede fix-registreringer og regressionstest.

> 💡 Hvis du finder andre problemer med kinesiske funktioner under brug, indsend venligst reproducerings-trin i [issue-området](./issues), så vil jeg fortsætte med at fejlrette.

### 🔬 Andre mindre fejlretninger (integrerede upstream-rettelser)

Denne gren bevarer fuldt ud en række mindre upstream-rettelser af brugeroplevelsesproblemer, der er blevet verificeret med regressionstest:

| Problem | Upstream-fix commit | Indflydelsesområde |
|------|-----------------|----------|
| 📋 **Kopier/indsæt indholdsbeskadigelse** — Indsatte prompt-indhold bliver fejlagtigt afkortet eller mister tegn i TUI'en | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI inputoplevelse |
| 📐 **Layout opdateres ikke efter indsæt** — Promptens boks-højde udvides ikke automatisk efter indsæt af lang tekst, hvilket giver visuel afkortning | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI inputoplevelse |
| 📎 **Ingen fallback ved udklipsholder-skrivningsfejl** — Når `navigator.clipboard` API fejler (HTTP-miljø osv.), fejler kopieringshandlingen direkte | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Tværgående browserkompatibilitet |
| 🎨 **Paste-badgets forgrundsfarve har utilstrækkelig kontrast** — Teksten på paste-oversigtsbadget er svær at læse i nogle temaer | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI visuel oplevelse |
| 📏 **CJK / østasiatisk tegnbreddeestimering** — Emojis, fuldbreddetegn, kanji osv. visningsbredde matcher ikke den faktiske optagelse, hvilket forårsager markørskævhed | Er integreret i systemet for CJK-tokeniseringsrettelser | TUI tegnjustering |
| ⌨️ **IME-kandidatvindue ryster** — Når kinesisk/japansk inputmetode er aktiv, ryster markøren + tegnindsættelse forsinkes | Lokal workaround-patch | TUI inputoplevelse |

> Denne gren genopfinder ikke hjulet: Upstream-rettelser synkroniseres via `stable`-grenens sammensmeltning; denne gren fejlretter primært upstream-problemer med kinesiske funktioner / DAG workflow, der endnu ikke er behandlet.

## Bevarede upstream-funktioner

Følgende funktioner stammer helt fra upstream opencode (MIT-licens); der er ikke foretaget funktionelle ændringer i denne fork:

### Desktopapplikation (BETA)

OpenCode tilbyder også en desktopversion. Den kan downloades direkte fra [udgivelsessiden](https://github.com/anomalyco/opencode/releases) eller [opencode.ai/download](https://opencode.ai/download).

| Platform              | Downloadfil                           |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` eller AppImage         |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agenter

OpenCode indeholder to indbyggede agenter, der kan skiftes med `Tab`-tasten:

- **build** - standardtilstand med fulde rettigheder, egnet til udviklingsarbejde
- **plan** - skrivebeskyttet tilstand, egnet til kodeanalyse og udforskning
  - Afviser som standard filændringer
  - Spørger før kørsel af bash-kommandoer
  - Praktisk til at udforske ukendte kodebaser eller planlægge ændringer

Derudover indeholder den en **general**-underagent til komplekse søgninger og flertrinsopgaver, som bruges internt, men også kan kaldes ved at skrive `@general` i en besked.

Læs mere om [Agenter](https://opencode.ai/docs/agents).

### ClaudeCode Hooks API supersæt-implementering

Denne fork bevarer fuldt ud upstream Hooks API-systemet med 22 runtime trigger-hændelser. Hooks registreres i konfigurationsfilens `hooks`-felt under hændelsesnavnet og understøtter fem udførelsestyper: `command`, `mcp`, `http`, `prompt`, `agent`, og kommunikerer via JSON-konvolutter over stdin/stdout. Den komplette protokol findes i [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

Detaljeret hændelsesliste og udførelsestyper findes i [README-bevarede afsnit](./docs/readmes/upstream-features.md).

## Licens og tilskrivning

Dette repository anvender en **blandet licensmodel**:

| Indhold | Licens | Placering |
|---------|--------|-----------|
| Upstream opencode-kode (langt de fleste filer) | **MIT** | Se [`LICENSE`](./LICENSE) |
| Egenudviklet DAG-workflowmotor (`packages/opencode/src/dag/` samt relaterede værktøjer, skabeloner, dokumentation) | **GNU AGPL v3** | Se [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Komplet grænsebeskrivelse findes i filen [`NOTICE`](./NOTICE).

### 🔒 AGPL v3 tvungen licenserklæring (hard begrænsning for denne gren)

**Denne repositorie-ejers politik for videreudvikling:**

1. **Egen kode skal anvende GNU AGPL v3** — enhver kode, der er tilføjet, omskrevet eller væsentligt ændret af forfatteren af denne gren **skal** være licenseret under GNU Affero General Public License v3 eller nyere (AGPL-3.0-or-later)
2. **AGPL's "copyleft"-krav** — ethvert projekt, der benytter, ændrer eller afledes af AGPL-3.0-moduler (f.eks. DAG-workflow-motoren), **skal offentliggøre sin fulde kildekode under AGPL-3.0** og skal give slutbrugere adgang til kildekoden
3. **SaaS tvungen open source** — hvis du implementerer dette projekt eller afledte værker som en netværkstjeneste (SaaS / cloud-platform), **skal du give alle brugere af tjenesten et komplet downloadlink til kildekoden** (dette er den centrale bestemmelse, der adskiller AGPL fra GPL, §13)
4. **Bevar ophavsangivelse** — original forfatterangivelse, copyright-notits og oplysninger i NOTICE-filen skal bevares

> ⚖️ **Hvorfor AGPL?** Forfatteren mener, at værdien af open source-software ligger i kontinuerligt samarbejde. AGPL forhindrer "lukket SaaS-udnyttelse" i at skade open source-fællesskabet – enhver kommerciel bruger, der drager fordel af dette projekt, skal give tilbage til fællesskabet.

**MIT-licenserede dele er ikke underlagt denne klausul** og styres udelukkende af opencode-teamet opstrøms.

### Forhold til det oprindelige opencode-team

- ✅ Dette projekt er **bygget på** [opencode](https://github.com/sst/opencode) opstrømskode
- ❌ Dette projekt har **ingen tilknytning eller autorisation** fra det officielle opencode-team (sst / anomalyco)
- ❌ Dette projekt er ikke en officiel opencode-udgivelse og giver ingen supportgaranti over for den officielle opstrømsversion
- ❌ **Det officielle OpenCode-team yder ingen teknisk support, garanti eller anbefaling af denne gren** (i henhold til opstrøms README's tydelige tilskrivningskrav)
- ✅ Dette projekts DAG-workflow-motor, kinesiske sprogfeatures, DEBUG-funktioner og andre forbedringer vedligeholdes uafhængigt af forfatteren
- ✅ Ophavsretten til den opstrøms MIT-kode bevares fuldt ud; forfatter- og copyright-oplysninger er ikke ændret

For at bruge den officielle version af opencode, besøg https://opencode.ai eller https://github.com/sst/opencode .

## Dokumentationsindeks

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Komplet dokumentation for Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Liste over kinesiske tegnrettelser
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Beskrivelse af bevarede upstream opencode-funktioner
- [`NOTICE`](./NOTICE) — Licensgrænse og tilskrivningserklæring
- [`AGENTS.md`](./AGENTS.md) — Guide til videreudvikling og bidrag

## Bidrag

Hvis du er interesseret i at bidrage med kode, så læs venligst [`CONTRIBUTING.md`](./CONTRIBUTING.md) før du indsender en PR.

### Udvikling baseret på denne fork

Hvis du bruger "opencode" i navnet på dit projekt (f.eks. "opencode-dashboard" eller "opencode-mobile"), skal du i README angive, at projektet ikke er officielt udviklet af OpenCode-teamet og ikke har noget tilknytningsforhold til forfatteren af denne fork.

## Ofte stillede spørgsmål (FAQ)

### Hvad er forskellen fra Claude Code?

Funktionelt er de meget ens, men de vigtigste forskelle er:

- 100% open source
- Ikke bundet til en bestemt udbyder. Modeller fra [OpenCode Zen](https://opencode.ai/zen) anbefales, men Claude, OpenAI, Google og endda lokale modeller kan også bruges
- Indbygget LSP-understøttelse
- Fokus på terminalgrænseflade (TUI)
- Klient/server-arkitektur. Kan køres lokalt og samtidig fjernstyres fra en mobilenhed

### Hvad er forskellen fra den officielle opencode-version?

- Tilføjet Harness-DAG-Workflow workflowmotor (AGPL-3.0)
- Løbende DEBUG af kompatibilitetsproblemer i kinesiske brugsscenarier
- Langsigtet uafhængig vedligeholdelse, afkoblet fra upstream-opdateringsrytmen

## Fællesskab

- 📖 [Upstream opencode-fællesskab](https://opencode.ai)
- 📝 [Issue-området for denne fork](./issues) (indberet problemer og forslag til nye funktioner)