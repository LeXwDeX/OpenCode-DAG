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
  <a href="./README_NO.md"><b>Norsk</b></a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (Forbedret utgave)

> **⚠️ Erklæring**: Dette prosjektet er en optimalisert forgrening av [opencode](https://github.com/sst/opencode), vedlikeholdt av en uavhengig utvikler basert på originalen. Dette prosjektet har **ingen tilknytning til det offisielle OpenCode-teamet** og er ikke tilknyttet dem på noen måte. Det opprinnelige prosjektet ble utgitt under MIT-lisens av opencode-teamet. Denne forgreningen beholder oppstrøms MIT-lisens og legger til flere egenutviklede moduler (se [NOTICE](./NOTICE) for detaljer).

## Introduksjon

Dette prosjektet er en **omarbeidet og forbedret versjon** av den offisielle opencode-versjonen, med følgende mål:

- 🔧 **Rette kinesiske språkproblemer**: Feilsøke en rekke kompatibilitetsproblemer med kinesisk tegndeling, CJK-tegnbehandling, tegn med full bredde, kinesiske filstier og kinesisk inndatametode (IME) i oppstrømsversjonen (se [liste over rettelser for kinesiske språkfunksjoner](./docs/localization/zh-hans-fixes.md))
- 🧩 **Tilby en produksjonsklar DAG-arbeidsflytmotor**: Egenutviklet [Harness-DAG-Workflow](./docs/harness-dag.md), som lar LLM-agenten orkestrere og kjøre flernodeoppgaver parallelt i én enkelt økt
- 🎯 **Beholde oppstrøms kompatibilitet**: All oppstrøms MIT-lisensiert kode forblir uendret – ingen ødeleggelse av eksisterende bygg, ingen forurensing av oppstrøms API-er

## Installasjon

```bash
# Direkte installasjon (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Pakkehåndterere
npm i -g opencode-ai@latest        # bun/pnpm/yarn kan også brukes
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS og Linux (anbefalt, alltid oppdatert)
brew install opencode              # macOS og Linux (offisiell brew-formel, oppdateres sjeldnere)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Ethvert system
nix run nixpkgs#opencode           # Eller bruk github:anomalyco/opencode for siste dev-gren
```

> [!TIP]
> Fjern eldre versjoner (før 0.1.x) før installasjon.

## Egenskaper spesifikke for denne grenen

Denne grenen er bygget på upstream opencode og **legger til** eller **forbedrer betydelig** følgende funksjoner (detaljer i hver seksjon):

| Egenskap | Kort beskrivelse | Lisens |
|---------|------------------|--------|
| 🧩 DAG HARNESS oppgave-orkestreringssystem | Lar LLM-agenten orkestrere flernode parallelle arbeidsflyter i én enkelt økt | AGPL-3.0 |
| 🪝 HOOKS API supersett-implementasjon | 22 kjøretidshendelser × 5 utførelsestyper – et komplett Hooks-rammeverk | MIT + forbedringer i denne grenen |
| 🛡️ Lettvekts isolert CODING-omgivelse | Sandbox + Worktree dobbeltspors isolert utførelsesmiljø | MIT + forbedringer i denne grenen |
| 🔧 DEBUG for kinesiske tegn | CJK-segmentering / fullbredde tegnsetting / IME-kompatibilitet / kinesiske filbaner | MIT |
| 🔬 Andre mindre DEBUG | Kopier-lim, østasiatiske tegnbredder, kinesisk utdataavkorting m.m. | MIT |

### 🧩 DAG HARNESS oppgave-orkestreringssystem (egenutviklet modul · AGPL-3.0)

Tidligere kjent som Harness-DAG-Workflow. En produksjonsklar **rettet asyklisk graf (DAG) arbeidsflytmotor** som lar LLM-agenten orkestrere komplekse parallelle oppgaver i én økt. Kjernefunksjoner:

- **Automatisk planlegging**: Spawner automatisk underagenter basert på nodeavhengigheter, utfører parallelt
- **Dynamisk omplanlegging**: Muliggjør sanntids omplanlegging av arbeidsflyten under kjøring (legg til/fjern/endre noder, juster samtidighetsgrenser)
- **Jernlovsoverholdelse**: Tilstandsmaskin kan ikke omgås, sluttilstander er irreversible, hendelser må kringkastes, persistens har prioritet
- **Slash-kommandosintegrasjon**: `/dag-ctl` for å kontrollere kjøring, `/dag-worker` for å konfigurere arbeidsflyt
- **Persistent revisjon**: SQLite med 6 tabeller, alle tilstandsendringer kan spores

Full arkitekturdokumentasjon finnes i [Harness-DAG-Workflow-dokumentasjon](./docs/harness-dag.md), utviklerveiledning i [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Lisens**: Denne modulen ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) og tilhørende maler og dokumentasjon) er lisensiert under **GNU AGPL v3** – all modifikasjon må frigis som åpen kildekode hvis du bruker denne modulen. Se [NOTICE](./NOTICE) og [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 HOOKS API supersett-implementasjon

Denne grenen beholder og forbedrer upstreams Hooks API-system:

- **22 kjøretidsutløsende hendelser**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 utførelsestyper**: `command` (shell) / `mcp` (MCP-verktøy) / `http` (REST) / `prompt` (enkel LLM-runde) / `agent` (flere LLM-runder)
- **stdin/stdout JSON-konvoluttkommunikasjonsprotokoll**: Full protokolldokumentasjon i [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Forbedringer i denne grenen**: Integrasjon med DAG-arbeidsflythendelsesbuss (`workflow.*` / `node.*`-hendelser) + TUI-abonnement + HTTP API-videresending

### 🛡️ Lettvekts isolert CODING-omgivelse

Denne grenen tilbyr et dobbeltspors isolert utførelsesmiljø slik at agent/bruker kan teste kode i en trygg sandkasse uten å forurense det faktiske repositoriet:

| Isolasjonsnivå | Mekanisme | Bruksområde |
|---------------|-----------|-------------|
| **Sandbox** (lett) | Midlertidig katalog + LSP-diagnostikk + flerspråklig verktøykjede (Python/Node/TS/Go/Rust/C/C++) | Enkel fil / små eksperimenter med kodekjøring |
| **Worktree** (tung) | `git worktree` uavhengig gren + uavhengig filsystemvisning | Parallell redigering av flere agenter, stor refaktorering |

- 📦 **Sandbox-verktøy**: `packages/opencode/src/tool/sandbox.ts`, hver sandkasse har uavhengig avhengighetsbuffer (venv / node_modules), støtter `ephemeral` engangsmodus og `background` asynkrone langvarige oppgaver
- 🌳 **DAG Worktree-behandler**: I DAG-arbeidsflyter kan hver parallelle node automatisk tildeles en uavhengig worktree-gren, og etter at noden er fullført, flettes den inn i hovedlinjen via `git merge`

### 🔧 DEBUG for kinesiske tegn (oppstrømsproblemer som er fikset)

Flere kompatibilitets-/opplevelsesproblemer for kinesiske bruksscenarier i upstream-versjonen er DEBUGget og optimalisert, og dekker:

- **Kinesisk segmentering og token-telling**: Unormal håndtering av CJK-tegn i enkelte tokenizere
- **Kompatibilitet med fullbredde tegnsetting**: Toleranse for fulle kolon, anførselstegn og parenteser i konfigurasjonsparsing
- **Håndtering av kinesiske filbaner**: Korrekt overføring av filbaner med mellomrom og CJK-tegn i hook/sandbox
- **IME-kompatibilitet**: Inndataforsinkelse og markørflimmer i TUI under IME-kandidatvindu

Detaljerte fikserapporter og regresjonstester finnes i [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Hvis du oppdager andre problemer med kinesisk støtte, vennligst send inn en reproduserbar sak i [issue-området](./issues), så vil jeg fortsette DEBUGging.

### 🔬 Andre mindre DEBUG (integrerte oppstrømsfikser)

Denne grenen beholder fullstendig flere mindre opplevelsesfikser fra upstream, verifisert gjennom regresjonstester:

| Problem | Upstream fiks commit | Påvirket område |
|---------|--------------------|------------------|
| 📋 **Ødelagt kopier-lim-innhold** — Brukerens limte prompt-tekst blir feilaktig avkortet eller mister tegn i TUI | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI inndataopplevelse |
| 📐 **Layout ikke oppdatert etter liming** — Promptboksen utvides ikke automatisk etter innliming av lang tekst, noe som gir visuell avkorting | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI inndataopplevelse |
| 📎 **Ingen fallback ved skriving til utklippstavle** — Når `navigator.clipboard`-API-et feiler (HTTP-miljø osv.), returneres feil uten alternativ | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Kryss-nettleserkompatibilitet |
| 🎨 **Utilstrekkelig kontrast for lime-merkes forgrunn** — Teksten i merkesymboler for limeoperasjoner er vanskelig å lese i enkelte temaer | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI visuell opplevelse |
| 📏 **Breddeestimering for CJK/østasiatiske tegn** — Emoji, fullbredde tegn, kinesiske tegn osv. har visningsbredder som ikke stemmer med faktisk plass, noe som forårsaker markørfeil | Inkludert i CJK-segmenteringsfikssystemet | TUI tegnjustering |
| ⌨️ **IME-kandidatvindusflimmer** — Markøren flimrer og tegninnsetting forsinkes når kinesisk/japansk inndatametode er aktiv | Lokal workaround-patch | TUI inndataopplevelse |

> Denne grenen gjenoppfinner ikke hjulet: Problemer som allerede er fikset i upstream vil bli synkronisert med `stable`-grenen etter sammenslåing; denne grenen DEBUGger hovedsakelig kinesisk-relaterte funksjoner og DAG-arbeidsflytproblemer som upstream ennå ikke har behandlet.

## Funksjoner beholdt fra oppstrøm

Følgende funksjoner stammer utelukkende fra oppstrøms opencode (MIT-lisensiert), og denne forgreningen har ikke gjort funksjonelle endringer:

### Skrivebordsapplikasjon (BETA)

OpenCode er også tilgjengelig som skrivebordsapplikasjon. Kan lastes ned direkte fra [utgivelsessiden](https://github.com/anomalyco/opencode/releases) eller [opencode.ai/download](https://opencode.ai/download).

| Plattform             | Nedlastingsfil                          |
| --------------------- | --------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg`   |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`       |
| Windows               | `opencode-desktop-windows-x64.exe`      |
| Linux                 | `.deb`, `.rpm` eller AppImage           |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agenter

OpenCode har to innebygde agenter. Bruk `Tab`-tasten for å bytte mellom dem:

- **build** – Standardmodus med fulle rettigheter, egnet for utviklingsarbeid
- **plan** – Skrivebeskyttet modus, egnet for kodeanalyse og utforskning
  - Avviser filendringer som standard
  - Spør før kjøring av bash-kommandoer
  - Passer for å utforske ukjente kodebaser eller planlegge endringer

I tillegg finnes en **general**-underagent for komplekse søk og flerstegsoppgaver, som brukes internt og også kan kalles ved å skrive `@general` i meldingen.

Lær mer om [agenter](https://opencode.ai/docs/agents).

### ClaudeCode Hooks API-supersettimplementasjon

Denne forgreningen bevarer oppstrøms Hooks API-system og 22 kjøretidsutløserhendelser fullt ut. Hooks registreres under `hooks`-feltet i konfigurasjonsfilen etter hendelsesnavn, og støtter fem utføringstyper: `command`, `mcp`, `http`, `prompt` og `agent`. Kommunikasjon skjer via en JSON-konvolutt over stdin/stdout. Se [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) for fullstendig protokollspesifikasjon.

Se [oppstrøms funksjonsbevaringskapitlet](./docs/readmes/upstream-features.md) for detaljert hendelsesliste og utføringstypeoversikt.

## Lisens og tilskrivning

Dette repositoriet bruker en **blandet lisensmodell**:

| Innhold | Lisens | Plassering |
|---------|--------|------------|
| Oppstrøms opencode-kode (de aller fleste filer) | **MIT** | Se [`LICENSE`](./LICENSE) |
| Egenutviklet DAG-arbeidsflytmotor (`packages/opencode/src/dag/` og tilhørende verktøy, maler, dokumentasjon) | **GNU AGPL v3** | Se [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Se [`NOTICE`](./NOTICE)-filen for fullstendig grensebeskrivelse.

### 🔒 AGPL v3 obligatorisk lisenserklæring (bindende vilkår for denne forgreningen)

**Forfatterens retningslinjer for videreutvikling av dette depotet:**

1. **Egenutviklet kode må lisensieres under GNU AGPL v3** — all kode som er ny, omskrevet eller vesentlig endret av forfatteren av denne forgreningen **må** bruke GNU Affero General Public License versjon 3 eller senere (AGPL-3.0-or-later)
2. **AGPLs smittekrav** — ethvert prosjekt som bruker, endrer eller avledes fra AGPL-3.0-moduler (f.eks. DAG-arbeidsflytmotoren), **må gjøre hele kildekoden tilgjengelig under AGPL-3.0** og må gi tilgang til sluttbrukerne
3. **Tvang til åpen kildekode for SaaS** — dersom du distribuerer dette prosjektet eller avledede verk som en nettjeneste (SaaS / skyplattform), **må du tilby en fullstendig kildekode-nedlastingslenke til alle brukere av tjenesten** (dette er kjernebestemmelsen i AGPL som skiller den fra GPL, §13)
4. **Opphavsrettsmerking** — opprinnelig forfatterangivelse, opphavsrettsnotis og tilskrivelse i NOTICE-filer må beholdes

> ⚖️ **Hvorfor AGPL?** Forfatteren mener at verdien av åpen kildekode ligger i kontinuerlig samarbeid. AGPL forhindrer “lukket SaaS-ifisering” i å utnytte åpen kildekode-fellesskapet – enhver kommersiell bruker som drar nytte av dette prosjektet, må gi tilbake til fellesskapet.

**Deler under MIT-lisensen er ikke omfattet av disse vilkårene** og kontrolleres kun av det opprinnelige opencode-teamet.

### Forholdet til det opprinnelige opencode-teamet

- ✅ Dette prosjektet er **bygget på** kildekoden fra [opencode](https://github.com/sst/opencode) oppstrøms
- ❌ Dette prosjektet har **ingen tilknytning til eller autorisasjon fra** det offisielle opencode-teamet (sst / anomalyco)
- ❌ Dette prosjektet er ikke en offisiell utgivelse av opencode og gir ingen støtteforpliktelser overfor offisiell oppstrøms
- ❌ **OpenCodes offisielle team gir ingen teknisk støtte, garantier eller godkjennelser for denne forgreningen** (i henhold til krav om tydelig tilskrivelse i oppstrøms README)
- ✅ Prosjektets DAG-arbeidsflytmotor, feilsøking av kinesisk funksjonalitet og andre forbedringer vedlikeholdes uavhengig av forfatteren
- ✅ Oppstrøms MIT-kode beholdes med fullstendig tilskrivelse, forfatter- og opphavsrettsmerking er ikke tuklet med

For den offisielle versjonen av opencode, besøk https://opencode.ai eller https://github.com/sst/opencode.

## Dokumentasjonsindeks

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Fullstendig Harness-DAG-Workflow-dokumentasjon
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Liste over rettelser for kinesiske språkfunksjoner
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Beskrivelse av bevarte oppstrøms opencode-funksjoner
- [`NOTICE`](./NOTICE) — Lisensgrenser og tilskrivningserklæring
- [`AGENTS.md`](./AGENTS.md) — Veiledning for videreutvikling og bidrag

## Bidra

Les [`CONTRIBUTING.md`](./CONTRIBUTING.md) før du sender inn en PR hvis du er interessert i å bidra.

### Utvikling basert på denne forgreningen

Hvis du bruker "opencode" i prosjektnavnet (f.eks. "opencode-dashboard" eller "opencode-mobile"), må du oppgi i README-en at prosjektet ikke er offisielt utviklet av OpenCode-teamet og ikke er tilknyttet forfatteren av denne forgreningen.

## Vanlige spørsmål (FAQ)

### Hva er forskjellen sammenlignet med Claude Code?

Funksjonsmessig ganske likt, med noen viktige forskjeller:

- 100 % åpen kildekode
- Ikke bundet til en bestemt leverandør. Anbefaler [OpenCode Zen](https://opencode.ai/zen)-modeller, men kan også brukes med Claude, OpenAI, Google eller lokale modeller
- Innebygd LSP-støtte
- Fokusert på terminalgrensesnitt (TUI)
- Klient/tjener-arkitektur. Kan kjøre lokalt og samtidig styres eksternt fra en mobil enhet
- **🪝 Hooks API-supersett**: bygger på Claude Codes 22 triggerhendelser × 5 utførelsestyper; denne forken er **fullt kompatibel med Claude Code Hooks-protokollen** og legger i tillegg til DAG-arbeidsflytens event-bus-integrasjon (`workflow.*` / `node.*`), TUI-abonnementer og videresending via HTTP API. Full spesifikasjon: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 Goal-instruksjonssystem**: `todowrite`-verktøyet + strukturert målsporing holder arbeidskøen til agent ved like gjennom lange flertrinnsøkter og hindrer at oppgavestatus går tapt når kontekstvinduet endres
- **🪝 TODO PreHook**: støtter injisering av TODO-listen i konteksten via `PreToolUse`-hooks; en hooks-drevet mekanisme for å vende tilbake til mål sørger for at agent alltid ser gjeldende fremdrift
- **🛡️ Sandbox Coding Workspace**: hver sandbox har egen midlertidig mappe, LSP-diagnostikk og flerspråklige toolchains (Python/Node/TS/Go/Rust/C/C++); agent kan prøve, kompilere og feilsøke kode isolert og først etter verifisering slå den inn i prosjektfiler via edit/write

### Hva er forskjellen sammenlignet med den offisielle opencode-versjonen?

- **🪝 Hooks API-supersett + Goal-instruksjoner + TODO PreHook + Sandbox Workspace**: beholder alle upstream Hooks-funksjoner og legger til DAG-hendelsesintegrasjon, strukturert oppgavesporing, hooks-drevet målreentry og en isolert flerspråklig coding sandbox
- **🧩 DAG WorkFlow-modus (WIP · ca. 90%)**: en egenutviklet [Harness-DAG-Workflow](./docs/harness-dag.md)-motor som lar en LLM agent orkestrere parallellarbeid med flere noder i én økt. Kjernefunksjonene er på plass (planlegging / livssyklus / pause-resume-cancel-replan-step / sub-DAG / betingede grener / data flow / crash recovery / probes), TUI-panelet er koblet til, og siste finpuss pågår
- **🔧 Kinesisk-kompatibilitetsfikser**: løpende DEBUG av CJK-tokenisering, fullbredde-tegnsetting, kinesiske stier og IME-edge cases fra upstream
- Langsiktig uavhengig vedlikehold, uavhengig av oppstrøms tempo

## Fellesskap

- 📖 [Oppstrøms opencode-fellesskap](https://opencode.ai)
- 📝 [Issue-seksjonen for denne forgreningen](./issues) (feilrapporter og forslag til nye funksjoner)
