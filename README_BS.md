<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README_EN.md">English</a> ·
  <a href="./README_AR.md">العربية</a> ·
  <a href="./README_BR.md">Português (Brasil)</a> ·
  <a href="./README_BS.md"><b>Bosanski</b></a> ·
  <a href="./README_DA.md">Dansk</a> ·
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

> **⚠️ Bosanski / Bosnian — MACHINE TRANSLATION**
> This document was machine-translated from the Chinese primary README.md using DeepSeek V4. No native-speaker review has been performed. For authoritative content, please refer to the [Chinese primary README](./README.md) or the [English README](./README_EN.md). If you'd like to help improve this translation, please open an issue or pull request.

# OpenCode (Prošireno izdanje)

> **⚠️ Izjava**: Ovaj projekat je optimizovana grana (fork) projekta [opencode](https://github.com/sst/opencode), koju samostalno održava nezavisni developer na temelju originala. Ovaj projekat nije povezan sa službenim OpenCode timom, ne postoji nikakva pripadnost. Originalni projekat je objavljen od strane opencode tima pod MIT licencom, a ova grana, uz očuvanje MIT licence originala, uvodi nekoliko samostalno razvijenih modula (vidi [NOTICE](./NOTICE)).

## Uvod

Ovaj projekat je **modifikovana i proširena verzija** službene opencode verzije, sa ciljem:

- 🔧 **Ispravljanje problema sa kineskim karakteristikama**: DEBUG nekoliko problema kompatibilnosti u vezi segmentacije kineskog teksta, obrade CJK karaktera, punih interpunkcijskih znakova, kineskih putanja i scenarija sa kineskim metodama unosa (IME) (detalji u [Listi popravki za kineske karakteristike](./docs/localization/zh-hans-fixes.md))
- 🧩 **Omogućavanje produkcijskog DAG radnog toka engine-a**: samostalno razvijen [Harness-DAG-Workflow](./docs/harness-dag.md), koji omogućava LLM agentu da u jednoj sesiji orkestrira i pokreće višenodalne paralelne zadatke
- 🎯 **Očuvanje kompatibilnosti sa originalom**: sav kod pod MIT licencom originala ostaje nepromijenjen, ne narušavajući postojeću izgradnju, ne zagađujući API originala

## Instalacija

```bash
# 直接安装 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 软件包管理器
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 和 Linux（推荐，始终保持最新）
brew install opencode              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任意系统
nix run nixpkgs#opencode           # 或用 github:anomalyco/opencode 获取最新 dev 分支
```

> [!TIP]
> Prije instalacije, uklonite stare verzije prije 0.1.x.


## Jedinstvene karakteristike ove grane

Ova grana izgrađena je na temelju izvornog projekta opencode i **dodaje** ili **značajno unapređuje** sljedeće mogućnosti (detalji u navedenim odjeljcima):

| Karakteristika | Kratak opis | Licenca |
|---------------|-------------|---------|
| 🧩 DAG HARNESS sistem za orkestraciju zadataka | Omogućava LLM agentu da u jednoj sesiji orkestrira paralelne tokove rada sa više čvorova | AGPL-3.0 |
| 🪝 Implementacija HOOKS API superseta | Kompletan sistem Hooks sa 22 vrste runtime događaja × 5 tipova izvršavanja | MIT + poboljšanja ove grane |
| 🛡️ Lagani izolovani prostor za kodiranje | Dvostruki izolovani izvršni okoliš Sandbox + Worktree | MIT + poboljšanja ove grane |
| 🔧 DEBUG za kineske karakteristike | CJK tokenizacija / interpunkcija pune širine / IME kompatibilnost / kineske putanje | MIT |
| 🔬 Ostali manji DEBUG | Kopiranje i lijepljenje, širina istočnoazijskih znakova, skraćivanje kineskog izlaza itd. | MIT |

### 🧩 DAG HARNESS sistem za orkestraciju zadataka (vlastiti modul · AGPL-3.0)

Prethodno poznat kao Harness-DAG-Workflow. Produkcijski **engine za tokove rada usmjerenih acikličkih grafova (DAG)** koji omogućava LLM agentu da u jednoj sesiji orkestrira složene paralelne zadatke. Osnovne mogućnosti:

- **Automatsko zakazivanje**: automatski pokreće pod-agente na osnovu međuzavisnosti čvorova i izvršava ih paralelno
- **Dinamičko ponovno planiranje**: mogućnost ponovnog planiranja toka rada u realnom vremenu (dodavanje/uklanjanje/izmjena čvorova, podešavanje maksimalnog stepena paralelizacije)
- **Stroga usklađenost**: konačni automat je nezaobilazan, krajnja stanja su ireverzibilna, događaji se obavezno emituju, prioritet ima trajno pohranjivanje
- **Integracija slash komandi**: `/dag-ctl` za kontrolu izvršavanja, `/dag-worker` za konfigurisanje toka rada
- **Trajna revizija**: SQLite shema sa 6 tabela, sve promjene stanja su sljedive

Kompletnu arhitekturu možete pronaći u [dokumentaciji Harness-DAG-Workflow](./docs/harness-dag.md), a razvojne smjernice u [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Licenca**: Ovaj modul ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) i pripadajući predlošci i dokumentacija) objavljen je pod licencom **GNU AGPL v3** – korištenje ovog modula zahtijeva otvaranje svih modifikacija. Vidi [NOTICE](./NOTICE) i [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 Implementacija HOOKS API superseta

Ova grana u potpunosti čuva i poboljšava Hooks API sistem iz izvornog projekta:

- **22 vrste runtime događaja**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 tipova izvršavanja**: `command` (shell) / `mcp` (MCP alat) / `http` (REST) / `prompt` (jednokružni LLM) / `agent` (višekružni LLM)
- **stdin/stdout JSON envelope komunikacijski protokol**: potpuna dokumentacija protokola u [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Poboljšanja ove grane**: integracija magistrale događaja DAG toka rada (`workflow.*` / `node.*` događaji) + TUI pretplata + HTTP API prosljeđivanje

### 🛡️ Lagani izolovani prostor za kodiranje

Ova grana pruža dvostruki izolovani izvršni okoliš koji omogućava agentu / korisniku da testira kod u sigurnom sandbox-u bez zagađivanja stvarnog repozitorija:

| Nivo izolacije | Mehanizam | Namjena |
|--------------|-----------|---------|
| **Sandbox** (lagani) | Privremeni direktorij + LSP dijagnostika + višejezični alati (Python/Node/TS/Go/Rust/C/C++) | Probno pokretanje koda za jednu datoteku / male eksperimente |
| **Worktree** (teški) | `git worktree` nezavisna grana + nezavisni prikaz sistema datoteka | Paralelno uređivanje od strane više agenata, opsežno refaktorisanje |

- 📦 **Sandbox alat**: `packages/opencode/src/tool/sandbox.ts`, svaki sandbox ima nezavisnu keš memoriju zavisnosti (venv / node_modules), podržava `ephemeral` jednokratni režim i `background` asinhroni dugotrajni zadatak
- 🌳 **DAG Worktree menadžer**: u DAG toku rada, svaki paralelni čvor može se automatski dodijeliti nezavisnoj worktree grani; nakon završetka čvora, promjene se spajaju u glavnu granu putem `git merge`

### 🔧 DEBUG za kineske karakteristike (riješeni problemi iz izvornog projekta)

Izvršeno je DEBUG-ovanje i optimizacija nekoliko problema kompatibilnosti / korisničkog iskustva uočenih u scenarijima korištenja kineskog jezika u izvornom projektu, obuhvatajući:

- **Kineska tokenizacija i brojanje tokena**: neispravno rukovanje CJK znakovima u nekim tokenizerima
- **Kompatibilnost sa interpunkcijom pune širine**: tolerancija na dvotočke, navodnike i zagrade pune širine pri parsiranju konfiguracije
- **Obrada kineskih putanja**: ispravno prosljeđivanje putanja koje sadrže razmake i CJK znakove u hook-ovima i sandbox-ovima
- **Kompatibilnost sa kineskim metodama unosa (IME)**: kašnjenje unosa i podrhtavanje kursora u TUI-u tokom aktivacije IME prozora sa kandidatima

 Detaljni zapisnici popravki i regresijski testovi nalaze se u [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Ako naiđete na druge probleme sa kineskim karakteristikama tokom korištenja, molimo vas da prijavite korake za reprodukciju u [issues području](./issues); nastaviću sa DEBUG-ovanjem.

### 🔬 Ostali manji DEBUG (integrirani popravci iz izvornog projekta)

Ova grana u potpunosti zadržava nekoliko popravki manjih problema u iskustvu iz izvornog projekta, koji su provjereni regresijskim testovima:

| Problem | Izvorni popravni commit | Oblast uticaja |
|---------|-------------------------|----------------|
| 📋 **Oštećenje sadržaja prilikom kopiranja i lijepljenja** — korisnički zalijepljeni prompt sadržaj se u TUI-u pogrešno skraćuje ili gubi znakove | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI iskustvo unosa |
| 📐 **Nedostatak osvježavanja izgleda nakon lijepljenja** — nakon lijepljenja dugog teksta, visina okvira za prompt se automatski ne povećava, što stvara vizuelni efekat skraćivanja | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI iskustvo unosa |
| 📎 **Nedostatak rezervnog mehanizma pri grešci upisa u međuspremnik** — kada `navigator.clipboard` API zakaže (npr. u HTTP okruženjima), operacija kopiranja direktno javlja grešku | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Kompatibilnost među preglednicima |
| 🎨 **Nedovoljan kontrast boje teksta kod značke lijepljenja** — tekst na znački sažetka lijepljenja je u nekim temama teško čitljiv | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI vizuelni doživljaj |
| 📏 **Procjena širine CJK / istočnoazijskih znakova** — širina prikaza emoji-ja, znakova pune širine, kineskih znakova i drugih istočnoazijskih znakova ne odgovara stvarnoj zauzetosti, što uzrokuje pogrešno pozicioniranje kursora | Uključeno u sistem popravki CJK tokenizacije | Poravnanje znakova u TUI-u |
| ⌨️ **Podrhtavanje prozora sa kandidatima IME** — prilikom aktivacije kineskog/japanskog metoda unosa, kursor podrhtava + kašnjenje pri umetanju znakova | Lokalni zaobilazni patch | TUI iskustvo unosa |

> Ova grana ne izmišlja točak: problemi koje je izvorni projekt već popravio bit će sinhronizirani sa spajanjem `stable` grane; ova grana je prvenstveno fokusirana na DEBUG-ovanje pitanja vezanih za kineske karakteristike / DAG tokove rada koja izvorni projekt još nije riješio.


## Zadržane mogućnosti iz originala

Sljedeće mogućnosti potiču u potpunosti iz originalnog opencode-a (MIT licenca), a ova grana nije vršila funkcionalne izmjene:

### Desktop aplikacija (BETA)

OpenCode također nudi desktop aplikaciju. Može se direktno preuzeti sa [stranice izdanja (releases)](https://github.com/anomalyco/opencode/releases) ili [opencode.ai/download](https://opencode.ai/download).

| Platforma               | Datoteka za preuzimanje               |
| ----------------------- | ------------------------------------- |
| macOS (Apple Silicon)   | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)           | `opencode-desktop-darwin-x64.dmg`     |
| Windows                 | `opencode-desktop-windows-x64.exe`    |
| Linux                   | `.deb`, `.rpm` ili AppImage            |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agenti

OpenCode ima ugrađene dvije vrste agenta, može se brzo prebacivati pomoću tipke `Tab`:

- **build** - podrazumijevani režim, ima pune dozvole, pogodan za razvojne poslove
- **plan** - režim samo za čitanje, pogodan za analizu koda i istraživanje
  - podrazumijevano odbija izmjene datoteka
  - pitaće prije pokretanja bash naredbi
  - pogodno za istraživanje nepoznatih baza koda ili planiranje izmjena

Također uključuje **general** pod-agent, za složene pretrage i višekoračne zadatke, koristi se interno, ali se može pozvati i unošenjem `@general` u poruci.

Saznajte više o [Agentima](https://opencode.ai/docs/agents).

### ClaudeCode Hooks API superset implementacija

Ova grana u potpunosti zadržava originalni Hooks API sistem i 22 runtime trigger događaja. Hook-ovi se registriraju u `hooks` polju konfiguracijske datoteke prema nazivu događaja, podržavajući pet tipova izvršenja: `command`, `mcp`, `http`, `prompt`, `agent`, i komuniciraju putem JSON omotača preko stdin/stdout. Kompletan protokol vidi u [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

Detaljan spisak događaja i tabelu tipova izvršenja potražite u [sačuvanim poglavljima originalnog README-a](./docs/readmes/upstream-features.md).

## Licenca i pripisivanje

Ovaj repozitorij koristi **hibridni model licenciranja**:

| Sadržaj                                                                                  | Licenca          | Lokacija                                                       |
| ----------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| Kod originalnog opencode-a (većina datoteka)                                              | **MIT**           | vidite [`LICENSE`](./LICENSE)                                  |
| Samostalno razvijen DAG radni tok engine (`packages/opencode/src/dag/` i povezani alati, šabloni, dokumentacija) | **GNU AGPL v3**   | vidite [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Kompletan opis granica pogledajte u datoteci [`NOTICE`](./NOTICE).


### 🔒 Obavezna licenca AGPL v3 (stroga obaveza ove grane)

**Politika autora ovog projekta za dalji razvoj repozitorija:**

1. **Samostalno razvijeni kod mora biti pod GNU AGPL v3** — svaki kod koji je autor ove grane dodao, prepisao ili značajno izmijenio **mora** biti licenciran pod GNU Affero General Public License v3 ili novijom verzijom (AGPL-3.0-or-later)
2. **Copyleft zahtjev AGPL-a (zaraznost)** — svaki projekat koji koristi, modificira ili je izveden iz AGPL-3.0 modula (kao što su DAG workflow engine i sl.), **mora objaviti svoj cjelokupni izvorni kod pod AGPL-3.0** i mora omogućiti pristup krajnjim korisnicima
3. **SaaS prisilno otvaranje koda** — ako ovaj projekat ili njegove izvedene radove postavite kao mrežni servis (SaaS / cloud platformu), **morate svim korisnicima te usluge osigurati link za preuzimanje kompletnog izvornog koda** (ovo je ključna odredba AGPL-a koja ga razlikuje od GPL-a, §13)
4. **Očuvanje imena autora** — moraju se zadržati izvorne izjave autora, napomene o autorskim pravima i informacije o pripadnosti iz NOTICE datoteke

> ⚖️ **Zašto AGPL?** Autor smatra da vrijednost softvera otvorenog koda leži u kontinuiranoj saradnji. AGPL sprječava štetu koju „zatvaranje koda u SaaS-u” nanosi zajednici otvorenog koda – svaki komercijalni korisnik koji ima koristi od ovog projekta mora uzvratiti zajednici.

**Dijelovi pod MIT licencom nisu obuhvaćeni ovim odredbama** i pod kontrolom su samo uzvodnog opencode tima.


### Odnos sa originalnim opencode timom

- ✅ Ovaj projekat je **izgrađen na osnovu** uzvodnog koda [opencode](https://github.com/sst/opencode)
- ❌ Ovaj projekat **nema nikakvu pripadnost niti ovlaštenje** od strane zvaničnog tima opencode-a (sst / anomalyco)
- ❌ Ovaj projekat nije zvanično izdanje opencode-a i ne daje obećanje podrške za zvanični uzvodni projekat
- ❌ **Zvanični OpenCode tim ne pruža nikakvu tehničku podršku, garanciju niti podršku ovoj grani** (prema jasnim zahtjevima o pripadnosti iz uzvodnog README dokumenta)
- ✅ DAG workflow engine, kineske funkcije DEBUG-a i druga unapređenja ovog projekta održava autor samostalno
- ✅ Pripadnost uzvodnog MIT koda je u potpunosti sačuvana, bez izmjena autorskih i autorskopravnih izjava

Ako želite koristiti zvaničnu verziju opencode-a, posjetite https://opencode.ai ili https://github.com/sst/opencode.

## Indeks dokumentacije

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Potpuna dokumentacija za Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Lista popravki za kineske karakteristike
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Opis zadržanih mogućnosti originalnog opencode-a
- [`NOTICE`](./NOTICE) — Izjava o granicama licence i pripisivanju
- [`AGENTS.md`](./AGENTS.md) — Vodič za sekundarni razvoj i doprinos

## Doprinošenje

Ako ste zainteresirani za doprinos kodu, pročitajte [`CONTRIBUTING.md`](./CONTRIBUTING.md) prije podnošenja PR-a.

### Razvoj na temelju ovog forka

Ako u nazivu projekta koristite "opencode" (npr. "opencode-dashboard" ili "opencode-mobile"), navedite u README-u da taj projekat nije službeno razvijen od strane OpenCode tima i da nema veze s autorom ovog forka.

## Često postavljana pitanja (FAQ)

### Po čemu se razlikuje od Claude Code-a?

Funkcionalno su vrlo slični, ključne razlike:

- 100% otvorenog koda
- Ne vezuje se za određenog pružatelja. Preporučuje se korištenje modela [OpenCode Zen](https://opencode.ai/zen), ali se može koristiti i sa Claude, OpenAI, Google ili lokalnim modelima.
- Ugrađena LSP podrška
- Fokus na terminalskom interfejsu (TUI)
- Klijent/server arhitektura. Može se pokretati lokalno, a udaljeno upravljati pomoću mobilnih uređaja
- **🪝 Hooks API superskup**: zasnovan na Claude Code-ovih 22 trigger događaja × 5 tipova izvršavanja; ovaj fork je **potpuno kompatibilan s Claude Code Hooks protokolom** i dodaje integraciju DAG event-bus-a (`workflow.*` / `node.*` događaji), TUI pretplate i prosljeđivanje preko HTTP API-ja. Puna specifikacija: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 Goal sistem instrukcija**: `todowrite` alat + strukturirano praćenje ciljeva čuvaju radni red agent-a tokom dugih višekorakih sesija i sprečavaju gubitak stanja zadataka pri promjeni kontekstnog prozora
- **🪝 TODO PreHook**: podržava ubacivanje TODO liste u kontekst putem `PreToolUse` hookova; hooks-driven mehanizam povratka na ciljeve osigurava da agent uvijek vidi trenutni napredak
- **🛡️ Sandbox Coding Workspace**: svaki sandbox ima zaseban privremeni direktorij, LSP dijagnostiku i višejezične toolchain-e (Python/Node/TS/Go/Rust/C/C++); agent može izolovano isprobavati, kompajlirati i debugovati kod, a nakon provjere ga spojiti u projektne fajlove putem edit/write

### Po čemu se razlikuje od službene verzije opencode-a?

- **🪝 Hooks API superskup + Goal instrukcije + TODO PreHook + Sandbox Workspace**: zadržava sve upstream Hooks mogućnosti i dodaje DAG event integraciju, strukturirano praćenje zadataka, hooks-driven povratak na ciljeve i izolovani višejezični coding sandbox
- **🧩 DAG WorkFlow način (WIP · oko 90%)**: vlastiti [Harness-DAG-Workflow](./docs/harness-dag.md) engine koji omogućava LLM agent-u orkestraciju paralelnih zadataka s više čvorova u jednoj sesiji. Ključne mogućnosti su implementirane (scheduling / lifecycle / pause-resume-cancel-replan-step / sub-DAG / uslovno grananje / data flow / crash recovery / probes), TUI panel je povezan, a završno poliranje je u toku
- **🔧 Ispravke kompatibilnosti za kineski jezik**: stalni DEBUG CJK tokenizacije, fullwidth interpunkcije, kineskih putanja i IME edge case-ova naslijeđenih iz upstream-a
- Dugoročno samostalno održavanje, neovisno o razvojnom tempu originala

## Zajednica

- 📖 [Zajednica originalnog opencode-a](https://opencode.ai)
- 📝 [Issue sekcija ove grane](./issues) (prijava problema i prijedlozi novih funkcionalnosti)
