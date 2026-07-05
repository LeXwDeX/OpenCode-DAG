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
  <a href="./README.bs.md"><b>Bosanski</b></a> ·
  <a href="./README.da.md">Dansk</a> ·
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

> **Unaprijeđeni fork [opencode](https://github.com/anomalyco/opencode) s production-grade DAG workflow pogonom za multi-agent orkestraciju.**

Napravljen na bazi [opencode](https://github.com/anomalyco/opencode) terminal AI agenta licenciranog pod MIT. **Nije povezan s niti odobren od OpenCode tima.**

---

## Status grana

| Grana | Baza | Sadržaj | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + optimizacija Tools | ✅ **Stabilno** |
| **`dag-branch`** | main + DAG | DAG workflow pogon (114 fajlova) | 🔧 **U razvoju** — adaptacija na v1.17.11 API-je |

> [!IMPORTANT]
> **DAG workflow pogon se trenutno portira** sa v1.15.10 u codebase v1.17.11.
> Nalazi se na grani `dag-branch` i **još uvijek nije funkcionalan**. Grana `main` je potpuno upotrebljiva
> s Hooks, Goal auto-petljom i izlaganjem Tools izuzetaka — sve spremno za produkciju.

---

## Šta ovaj fork čini drugačijim

### 📌 Stabilno na `main`

#### Hooks API (26 događaja × 5 tipova izvršenja)

Puna kompatibilnost s hooks protokolom Claude Code: tipovi hookova `command`, `mcp`, `http`, `prompt`, `agent` s 26 hook događaja uključujući `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` i više. Hookovi se učitavaju iz globalnog / projektnog / worktree `hooks.json` lanca, ili se mogu registrovati po sesiji tokom izvršenja preko HTTP API-ja; opcionalno workspace-trust kontrola (`requireTrust` + komanda `/trust`) ograničava izvršenje hookova na direktorije koje ste odobrili.

Vidi [hooks referencu](./packages/core/src/plugin/skill/configure-hooks.md).

#### Goal auto-petlja

Autonomna petlja agenta koja kontinuirano vodi agenta ka korisnički definisanom cilju. LLM sudija nakon svakog poteza odlučuje da li je cilj postignut ili su potrebni dodatni potezi, unutar konfigurabilnog budžeta poteza. `/goal <target>` za postavljanje, `/subgoal` za dodavanje podciljeva, `/goal resume` za nastavak pauziranog cilja.

#### Izlaganje Tools izuzetaka

- **Popravka JSON-a**: `safeParseJson` + `fixJsonUnicodeEscapes` — popravlja pokvarene multi-byte Unicode escape-ove u JSON-u koji generiše LLM
- **Validacija Question alata**: strukturirano formatiranje grešaka s hintovima na nivou polja i primjerima ispravnog poziva
- **Opisi alata**: prošireni `.txt` dokumenti za `question`, `task`, `skill`, `webfetch`, `websearch` s Parameters + Returns sekcijama
- **Popravka shell cijevi**: `stdout/stderr: "pipe"` na svim `ChildProcess.make` pozivima + reader fiber grace drain

### 🔧 U razvoju na `dag-branch`

#### DAG Workflow pogon (AGPL-3.0)

**Pogon za DAG workflow (usmjereni aciklički graf)** koji omogućava LLM agentima da orkestriraju složene multi-node paralelne zadatke unutar jedne sesije.

> ⚠️ **Status**: Sirovo kopiran iz v1.15.10 forka (114 fajlova). 217 tip-grešaka čeka adaptaciju API-ja (sinhroni `Database.use` → Effect-bazirani `Database.Service`, `Bus` → `EventV2Bridge`, itd.). Još uvijek se ne kompajlira.

| Sposobnost | Opis |
|---|---|
| **Auto-zakazivanje** | Stvara child agente prema redu zavisnosti, paralelno gdje je moguće |
| **Dinamičko preplaniranje** | Dodavanje/uklanjanje/ažuriranje čvorova i podešavanje konkurencije tokom izvršenja |
| **Integritet state machine-a** | Četiri gvozdena zakona: zabranjeno zaobilaženje state machine-a, terminalna stanja nepovratna, događaji moraju biti emitovani, persist prije mutacije |
| **Terminal TUI** | Puna DAG kontrolna ploča s block-char mapom topologije, stablastim prikazom, dijalozima čvorova, ažuriranjima u realnom vremenu |
| **Oporavak od kraha** | Detektuje i nastavlja napuštene pokrenute workflove pri restartu |
| **Uslovno grananje** | Čvorovi mogu uslovno izvršavati ili preskakati na osnovu upstream izlaza |
| **Sub-DAG ugnježđivanje** | Tip workera `dag` stvara rekurzivne sub-workflowove (max dubina 3) |
| **Persistna revizija** | SQLite šema s 6 tabela, svi prelazi stanja su pratljivi |

### CJK i popravke lokalizacije

Opsežne popravke za obradu kineskog/japanskog/korejskog teksta: tokenizacija, full-width interpunkcija, putanje fajlova, IME unos u terminal UI-ju. Vidi [listu popravki](./docs/localization/zh-hans-fixes.md).

### Dvostruka izolacija: Sandbox + Worktree

- **Sandbox** — ephemeral temp direktoriji s LSP dijagnostikom za sigurne eksperimente s kodom
- **Worktree** — `git worktree` izolacija po-workflow za paralelno multi-agent editovanje

---

## Instalacija

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Prije instalacije uklonite verzije starije od 0.1.x.

---

## Zadrži upstream — i više

Sve upstream MIT-licencirane sposobnosti su u potpunosti zadržane:

- **Desktop aplikacija** (macOS / Windows / Linux) — preuzmi iz [releases](https://github.com/anomalyco/opencode/releases)
- **Build & Plan agenti** — `Tab` za prebacivanje između full-access i read-only režima
- **Multi-provider** — Claude, OpenAI, Google, lokalni modeli preko [OpenCode Zen](https://opencode.ai/zen)
- **Ugrađeni LSP** — dijagnostika u realnom vremenu od jezičkih servera
- **Klijent/server arhitektura** — pokreni lokalno, upravljaj udaljeno s mobilnog

Ovaj fork dodaje DAG pogon, CJK popravke, sandbox coding workspace i goal tracking na vrhu — bez ičega lomljenja.

---

## Licenca

Ovaj repozitorij koristi **mješoviti model licenciranja**:

| Sadržaj | Licenca | Lokacija |
|---------|---------|----------|
| Upstream opencode kod (velika većina) | **MIT** | [`LICENSE`](./LICENSE) |
| Samostalno razvijen DAG workflow pogon | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Puni detalji granica u [`NOTICE`](./NOTICE).

> ⚖️ **Zašto AGPL?** DAG pogon je ključni diferencirani rad. AGPL osigurava da bilo koji derivat — uključujući SaaS implementacije — mora dati doprinos nazad.

---

## Dokumentacija

- [`docs/harness-dag.md`](./docs/harness-dag.md) — arhitektura i upotreba DAG pogona
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — katalog CJK popravki
- [`NOTICE`](./NOTICE) — granice licence i atribucija
- [`AGENTS.md`](./AGENTS.md) — vodič za doprinos i razvoj

## Zajednica

- 📖 [Upstream opencode zajednica](https://opencode.ai)
- 📝 [Tracker problema forka](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
