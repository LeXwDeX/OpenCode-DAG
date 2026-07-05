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
  <a href="./README.it.md"><b>Italiano</b></a> ·
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

> **Un fork migliorato di [opencode](https://github.com/anomalyco/opencode) con un motore di workflow DAG di grado produttivo per l'orchestrazione multi-agente.**

Costruito sopra l'agente IA per terminale [opencode](https://github.com/anomalyco/opencode) con licenza MIT. **Non affiliato né approvato dal team di OpenCode.**

---

## Stato dei branch

| Branch | Base | Contenuto | Stato |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + ottimizzazione degli strumenti | ✅ **Stabile** |
| **`dag-branch`** | main + DAG | Motore di workflow DAG (114 file) | 🔧 **In sviluppo** — adattamento alle API di v1.17.11 |

> [!IMPORTANT]
> Il **motore di workflow DAG è attualmente in fase di porting** da v1.15.10 alla base di codice v1.17.11.
> Si trova sul branch `dag-branch` e **non è ancora funzionante**. Il branch `main` è pienamente utilizzabile con Hooks,
> il ciclo automatico Goal e l'esposizione delle eccezioni degli strumenti — tutto pronto per la produzione.

---

## Cosa rende diverso questo fork

### 📌 Stabile su `main`

#### API Hooks (26 eventi × 5 tipi di esecuzione)

Compatibilità completa con il protocollo di hook di Claude Code: tipi di hook `command`, `mcp`, `http`, `prompt`, `agent` con 26 eventi di hook tra cui `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, e altri. Gli hook si caricano da una catena `hooks.json` globale / di progetto / di worktree, oppure possono essere registrati per sessione a runtime tramite la HTTP API; il controllo opzionale dell'attendibilità del workspace (`requireTrust` + il comando `/trust`) limita l'esecuzione degli hook alle directory che hai approvato.

Vedi il [riferimento degli hook](./packages/core/src/plugin/skill/configure-hooks.md).

#### Ciclo automatico Goal

Un ciclo di agente autonomo che guida continuamente un agente verso un obiettivo definito dall'utente. Un giudice LLM decide dopo ogni turno se l'obiettivo è raggiunto o servono altri turni, entro un budget di turni configurabile. `/goal <obiettivo>` per impostare, `/subgoal` per aggiungere sotto-obiettivi, `/goal resume` per riprendere un obiettivo in pausa.

#### Esposizione delle eccezioni degli strumenti

- **Riparazione JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — ripara gli escape Unicode multibyte rotti nel JSON generato dai LLM
- **Validazione dello strumento Question**: formattazione strutturata degli errori con suggerimenti a livello di campo ed esempi di chiamate corrette
- **Descrizioni degli strumenti**: documenti `.txt` ampliati per `question`, `task`, `skill`, `webfetch`, `websearch` con sezioni Parametri + Valore restituito
- **Correzione della pipe della shell**: `stdout/stderr: "pipe"` su tutte le chiamate a `ChildProcess.make` + drenaggio graceful della fiber di lettura

### 🔧 In sviluppo su `dag-branch`

#### Motore di workflow DAG (AGPL-3.0)

Un **motore di workflow a grafo orientato aciclico (DAG)** che consente agli agenti LLM di orchestrare compiti paralleli multi-nodo complessi all'interno di una singola sessione.

> ⚠️ **Stato**: Copiato grezzo dal fork v1.15.10 (114 file). 217 errori di tipo in attesa di adattamento alle API (`Database.use` sincrono → `Database.Service` basato su Effect, `Bus` → `EventV2Bridge`, ecc.). Non ancora compilabile.

| Funzionalità | Descrizione |
|---|---|
| **Pianificazione automatica** | Genera agenti figli in base all'ordine delle dipendenze, in parallelo dove possibile |
| **Ripianificazione dinamica** | Aggiungere/rimuovere/aggiornare nodi e regolare la concorrenza durante l'esecuzione |
| **Integrità della macchina a stati** | Quattro leggi ferree: il bypass della macchina a stati è vietato, gli stati terminali sono irreversibili, gli eventi devono essere trasmessi, persistere prima di mutare |
| **TUI da terminale** | Pannello di controllo DAG completo con mappa topologica a caratteri di blocco, vista ad albero, finestre di dialogo dei nodi, aggiornamenti in tempo reale |
| **Ripristino dopo crash** | Rileva e riprende i workflow orfani in esecuzione al riavvio |
| **Diramazione condizionale** | I nodi possono eseguirsi o saltarsi condizionalmente in base all'output a monte |
| **Annidamento di sub-DAG** | Il tipo di worker `dag` genera sub-workflow ricorsivi (profondità massima 3) |
| **Audit persistente** | Schema SQLite a 6 tabelle, tutte le transizioni di stato tracciabili |

### Correzioni CJK e di localizzazione

Numerose correzioni per la gestione del testo cinese/giapponese/coreano: tokenizzazione, punteggiatura a larghezza piena, percorsi dei file, input IME nell'interfaccia del terminale. Vedi la [lista delle correzioni](./docs/localization/zh-hans-fixes.md).

### Doppio isolamento: Sandbox + Worktree

- **Sandbox** — directory temporanee effimere con diagnostica LSP per esperimenti di codice sicuri
- **Worktree** — isolamento `git worktree` per workflow per modifica multi-agente in parallelo

---

## Installazione

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Rimuovi le versioni precedenti alla 0.1.x prima di installare.

---

## Mantieni l'upstream — e altro ancora

Tutte le capacità dell'upstream con licenza MIT sono pienamente preservate:

- **App desktop** (macOS / Windows / Linux) — scaricabile dai [releases](https://github.com/anomalyco/opencode/releases)
- **Agenti Build & Plan** — `Tab` per alternare tra modalità ad accesso completo e sola lettura
- **Multi-provider** — Claude, OpenAI, Google, modelli locali tramite [OpenCode Zen](https://opencode.ai/zen)
- **LSP integrato** — diagnostica in tempo reale dai server dei linguaggi
- **Architettura client/server** — esegui in locale, guida da remoto dal cellulare

Questo fork aggiunge il motore DAG, le correzioni CJK, il workspace di codifica sandbox e il tracciamento degli obiettivi sopra — senza rompere nulla.

---

## Licenza

Questo repository usa un **modello di licenza misto**:

| Contenuto | Licenza | Posizione |
|---------|---------|----------|
| Codice di opencode upstream (la grande maggioranza) | **MIT** | [`LICENSE`](./LICENSE) |
| Motore di workflow DAG sviluppato internamente | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Dettagli completi dei confini in [`NOTICE`](./NOTICE).

> ⚖️ **Perché AGPL?** Il motore DAG è il lavoro differenziante principale. AGPL garantisce che qualsiasi derivato — incluse le distribuzioni SaaS — debba contribuire indietro.

---

## Documentazione

- [`docs/harness-dag.md`](./docs/harness-dag.md) — architettura e uso del motore DAG
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — catalogo delle correzioni CJK
- [`NOTICE`](./NOTICE) — confini di licenza e attribuzione
- [`AGENTS.md`](./AGENTS.md) — guida di contribuzione e sviluppo

## Community

- 📖 [Community opencode upstream](https://opencode.ai)
- 📝 [Issue tracker del fork](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
