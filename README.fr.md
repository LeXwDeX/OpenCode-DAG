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
  <a href="./README.fr.md"><b>Français</b></a> ·
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

> **Un fork amélioré d'[opencode](https://github.com/anomalyco/opencode) avec un moteur de workflow DAG de qualité production pour l'orchestration multi-agents.**

Construit par-dessus l'agent IA pour terminal [opencode](https://github.com/anomalyco/opencode) sous licence MIT. **Sans affiliation ni approbation de l'équipe OpenCode.**

---

## Statut des branches

| Branche | Base | Contenu | Statut |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + optimisation des outils | ✅ **Stable** |
| **`dag-branch`** | main + DAG | Moteur de workflow DAG (114 fichiers) | 🔧 **En développement** — adaptation aux API v1.17.11 |

> [!IMPORTANT]
> Le **moteur de workflow DAG est actuellement en cours de portage** de v1.15.10 vers la base de code v1.17.11.
> Il se trouve sur la `dag-branch` et n'est **pas encore fonctionnel**. La branche `main` est entièrement utilisable
> avec les Hooks, la boucle automatique Goal et l'exposition des exceptions d'outils — tout est prêt pour la production.

---

## Ce qui différencie ce fork

### 📌 Stable sur `main`

#### API Hooks (26 événements × 5 types d'exécution)

Compatibilité complète avec le protocole de hooks de Claude Code : types de hooks `command`, `mcp`, `http`, `prompt`, `agent` avec 26 événements de hook dont `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, et plus. Les hooks se chargent depuis une chaîne `hooks.json` globale / projet / worktree, ou peuvent être enregistrés par session à l'exécution via l'HTTP API ; un contrôle optionnel de confiance de l'espace de travail (`requireTrust` + la commande `/trust`) limite l'exécution des hooks aux répertoires que vous avez approuvés.

Voir la [référence des hooks](./packages/core/src/plugin/skill/configure-hooks.md).

#### Boucle automatique Goal

Une boucle d'agent autonome qui pilote en continu un agent vers un objectif défini par l'utilisateur. Un juge LLM décide après chaque tour si l'objectif est atteint ou nécessite d'autres tours, dans un budget de tours configurable. `/goal <cible>` pour définir, `/subgoal` pour ajouter des sous-objectifs, `/goal resume` pour reprendre un objectif mis en pause.

#### Exposition des exceptions d'outils

- **Réparation JSON** : `safeParseJson` + `fixJsonUnicodeEscapes` — répare les échappements Unicode multi-octets cassés dans le JSON généré par les LLM
- **Validation de l'outil Question** : formatage structuré des erreurs avec des indices au niveau des champs et des exemples d'appels corrects
- **Descriptions des outils** : docs `.txt` étendus pour `question`, `task`, `skill`, `webfetch`, `websearch` avec des sections Paramètres + Retours
- **Correction du pipe shell** : `stdout/stderr: "pipe"` sur tous les appels `ChildProcess.make` + vidange de grâce de la fibre de lecture

### 🔧 En développement sur `dag-branch`

#### Moteur de workflow DAG (AGPL-3.0)

Un **moteur de workflow à graphe orienté acyclique (DAG)** qui permet aux agents LLM d'orchestrer des tâches parallèles multi-nœuds complexes au sein d'une même session.

> ⚠️ **Statut** : Copié brut du fork v1.15.10 (114 fichiers). 217 erreurs de type en attente d'adaptation aux API (`Database.use` synchrone → `Database.Service` basé sur Effect, `Bus` → `EventV2Bridge`, etc.). Pas encore compilable.

| Fonctionnalité | Description |
|---|---|
| **Planification automatique** | Génère des agents enfants selon l'ordre des dépendances, en parallèle quand c'est possible |
| **Replanification dynamique** | Ajout/suppression/mise à jour de nœuds et ajustement de la concurrence en cours d'exécution |
| **Intégrité de la machine à états** | Quatre lois fondamentales : contournement de la machine à états interdit, états terminaux irréversibles, les événements doivent être diffusés, persister avant de muter |
| **TUI terminal** | Panneau de contrôle DAG complet avec carte topologique en caractères blocs, vue arborescente, boîtes de dialogue de nœuds, mises à jour en temps réel |
| **Récupération après crash** | Détecte et reprend les workflows orphelins en cours au redémarrage |
| **Branchement conditionnel** | Les nœuds peuvent s'exécuter ou être ignorés de façon conditionnelle selon la sortie amont |
| **Imbrication de sous-DAG** | Le type de worker `dag` génère des sous-workflows récursifs (profondeur max 3) |
| **Audit persistant** | Schéma SQLite à 6 tables, toutes les transitions d'état traçables |

### Corrections CJK et de localisation

De nombreuses corrections pour le traitement du texte chinois/japonais/coréen : tokenisation, ponctuation pleine chasse, chemins de fichiers, saisie IME dans l'interface terminal. Voir la [liste des corrections](./docs/localization/zh-hans-fixes.md).

### Double isolation : Sandbox + Worktree

- **Sandbox** — répertoires temporaires éphémères avec diagnostics LSP pour des expérimentations de code sûres
- **Worktree** — isolation `git worktree` par workflow pour de l'édition multi-agents parallèle

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
> Supprimez les versions antérieures à 0.1.x avant l'installation.

---

## Gardez l'amont — et plus encore

Toutes les fonctionnalités amont sous licence MIT sont entièrement préservées :

- **Application desktop** (macOS / Windows / Linux) — à télécharger depuis les [releases](https://github.com/anomalyco/opencode/releases)
- **Agents Build & Plan** — `Tab` pour basculer entre les modes accès complet et lecture seule
- **Multi-fournisseur** — Claude, OpenAI, Google, modèles locaux via [OpenCode Zen](https://opencode.ai/zen)
- **LSP intégré** — diagnostics en temps réel depuis les serveurs de langage
- **Architecture client/serveur** — exécution en local, pilotage à distance depuis mobile

Ce fork ajoute le moteur DAG, les corrections CJK, l'espace de travail de codage sandbox et le suivi d'objectifs par-dessus — sans rien casser.

---

## Licence

Ce dépôt utilise un **modèle de licence mixte** :

| Contenu | Licence | Emplacement |
|---------|---------|----------|
| Code opencode amont (la grande majorité) | **MIT** | [`LICENSE`](./LICENSE) |
| Moteur de workflow DAG développé en interne | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Détails complets des frontières dans [`NOTICE`](./NOTICE).

> ⚖️ **Pourquoi AGPL ?** Le moteur DAG est le travail différenciateur principal. AGPL garantit que tout dérivé — y compris les déploiements SaaS — doive contribuer en retour.

---

## Documentation

- [`docs/harness-dag.md`](./docs/harness-dag.md) — architecture et utilisation du moteur DAG
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — catalogue des corrections CJK
- [`NOTICE`](./NOTICE) — frontières de licence et attribution
- [`AGENTS.md`](./AGENTS.md) — guide de contribution et de développement

## Communauté

- 📖 [Communauté opencode amont](https://opencode.ai)
- 📝 [Suivi des issues du fork](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
