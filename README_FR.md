<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 l'auteur du fork (voir le fichier NOTICE pour l'attribution).
Sous licence GNU AGPL v3 ; toute modification doit être rendue open source.
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
  <a href="./README_FR.md"><b>Français</b></a> ·
  <a href="./README_JA.md">日本語</a> ·
  <a href="./README_KO.md">한국어</a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (Édition améliorée)

> **⚠️ Avertissement** : Ce projet est un fork amélioré d'[opencode](https://github.com/sst/opencode), maintenu de façon indépendante par son auteur. Il n'est **ni affilié à, ni approuvé par, ni soutenu officiellement** par l'équipe OpenCode. Le projet original est publié sous licence MIT par l'équipe opencode. Ce fork conserve le code sous licence MIT en amont tout en ajoutant de nouveaux modules propriétaires soumis à une licence copyleft renforcée. Voir [NOTICE](./NOTICE) pour plus de détails.

## Présentation

Il s'agit d'une **réinterprétation et version améliorée** de la version amont d'`opencode`, axée sur :

- 🔧 **Correction des cas limites liés à la langue chinoise** — bogues résolus concernant la tokenisation CJK, la ponctuation pleine largeur, les chemins en chinois et les interactions avec les méthodes de saisie (IME) détectés dans la version amont (voir le [journal des corrections CJK](./docs/localization/zh-hans-fixes.md))
- 🧩 **Mise à disposition d'un moteur de workflow DAG de niveau production** — le module auto-développé [Harness-DAG-Workflow](./docs/harness-dag.md) permet aux agents LLM d'orchestrer des tâches parallèles multi-nœuds au sein d'une seule session
- 🎯 **Préservation de la compatibilité amont** — le code sous licence MIT en amont reste fonctionnellement inchangé, sans casse de compilation ni pollution de l'API

## Installation

```bash
# Installation directe (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Gestionnaires de paquets
npm i -g opencode-ai@latest        # fonctionne également avec bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS et Linux (recommandé, toujours à jour)
brew install opencode              # macOS et Linux (formule officielle, moins fréquente)
sudo pacman -S opencode            # Arch Linux (stable)
paru -S opencode-bin               # Arch Linux (dernière version depuis AUR)
mise use -g opencode               # tout système d'exploitation
nix run nixpkgs#opencode           # ou utiliser github:anomalyco/opencode pour la dernière branche dev
```

> [!TIP]
> Supprimez les versions antérieures à 0.1.x avant d'installer.

## Fonctionnalités propres à cette branche

Cette branche est basée sur opencode en amont, avec les **ajouts** ou **améliorations significatives** suivants (détails dans chaque section) :

| Fonctionnalité | Description courte | Licence |
|------|------|------|
| 🧩 DAG HARNESS système d'orchestration de tâches | Permet à un agent LLM d'orchestrer des flux de travail parallèles multi-nœuds en une seule session | AGPL-3.0 |
| 🪝 Implémentation superset de l'API HOOKS | 22 types d'événements d'exécution × 5 modes d'exécution, système de hooks complet | MIT + améliorations de cette branche |
| 🛡️ Espace d'isolation CODING léger | Environnement d'exécution isolé double rail Sandbox + Worktree | MIT + améliorations de cette branche |
| 🔧 CORRECTIONS des fonctionnalités chinoises | Segmentation CJK / ponctuation pleine chasse / compatibilité IME / chemins en chinois | MIT |
| 🔬 Autres petites CORRECTIONS | Copier-coller, largeur des caractères est-asiatiques, troncature des sorties en chinois, etc. | MIT |

### 🧩 DAG HARNESS système d'orchestration de tâches (module développé en interne · AGPL-3.0)

Anciennement Harness-DAG-Workflow. Un moteur de workflow **à graphe orienté acyclique (DAG)** de niveau production, permettant à un agent LLM d'orchestrer des tâches parallèles complexes en une seule session. Capacités clés :

- **Ordonnancement automatique** : Crée automatiquement des sous-agents selon les dépendances des nœuds, exécution en parallèle
- **Replanification dynamique** : Possibilité de replanifier le workflow à la volée (ajout/suppression/modification de nœuds, ajustement de la limite de concurrence)
- **Conformité rigoureuse** : Machine à états infranchissable, états terminaux irréversibles, événements toujours diffusés, persistance prioritaire
- **Intégration des commandes Slash** : `/dag-ctl` pour contrôler l'exécution, `/dag-worker` pour configurer le workflow
- **Audit persistant** : Schéma SQLite à 6 tables, toutes les transitions d'état traçables

L'architecture complète est documentée dans [la documentation Harness-DAG-Workflow](./docs/harness-dag.md), le guide de développement dans [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Licence** : Ce module ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) et les templates/documentation associés) est publié sous licence **GNU AGPL v3** — toute utilisation de ce module impose d'ouvrir toutes les modifications. Voir [NOTICE](./NOTICE) et [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 Implémentation superset de l'API HOOKS

Cette branche conserve et étend intégralement le système d'API Hooks de l'amont :

- **22 événements déclencheurs d'exécution** : `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 types d'exécution** : `command` (shell) / `mcp` (outil MCP) / `http` (REST) / `prompt` (LLM monotour) / `agent` (LLM multi-tours)
- **Protocole de communication par enveloppe JSON stdin/stdout** : Documentation complète du protocole dans [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Améliorations de cette branche** : Intégration du bus d'événements du workflow DAG (événements `workflow.*` / `node.*`) + abonnement TUI + relais API HTTP

### 🛡️ Espace d'isolation CODING léger

Cette branche propose un environnement d'exécution isolé à double rail, permettant aux agents/utilisateurs de tester du code dans un bac à sable sécurisé sans polluer le dépôt réel :

| Niveau d'isolation | Mécanisme | Utilisation |
|---------|------|------|
| **Sandbox** (léger) | Répertoire temporaire + diagnostics LSP + chaînes d'outils multilangages (Python/Node/TS/Go/Rust/C/C++) | Essais de code sur fichier unique / petites expériences |
| **Worktree** (lourd) | `git worktree` branche indépendante + vue de système de fichiers séparée | Édition parallèle multi-agents, refactoring à grande échelle |

- 📦 **Outil Sandbox** : `packages/opencode/src/tool/sandbox.ts`, chaque sandbox dispose d'un cache de dépendances indépendant (venv / node_modules), support des modes `ephemeral` (jetable) et `background` (tâche longue asynchrone)
- 🌳 **Gestionnaire de Worktrees DAG** : Dans un workflow DAG, chaque nœud parallèle peut être automatiquement assigné à une branche worktree indépendante, fusionnée dans la branche principale via `git merge` une fois le nœud terminé

### 🔧 CORRECTIONS des fonctionnalités chinoises (problèmes amont résolus)

Correction et optimisation de plusieurs problèmes de compatibilité/expérience rencontrés dans les scénarios d'utilisation en chinois avec la version amont, couvrant :

- **Segmentation du chinois et comptage de tokens** : Gestion anormale des caractères CJK dans certains tokenizers
- **Compatibilité de la ponctuation pleine chasse** : Tolérance aux deux-points, guillemets, parenthèses pleine chasse dans l'analyse de configuration
- **Gestion des chemins en chinois** : Transmission correcte des chemins contenant des espaces et caractères CJK dans les hooks/sandbox
- **Compatibilité des méthodes de saisie (IME) pour le chinois** : Latence de saisie et tremblement du curseur en TUI lorsque la fenêtre candidate de l'IME est active

Le détail des corrections et les tests de régression sont documentés dans [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Si vous rencontrez d'autres problèmes de fonctionnalités chinoises, veuillez soumettre les étapes de reproduction dans [les issues](./issues), je continuerai à corriger.

### 🔬 Autres petites CORRECTIONS (correctifs amont intégrés)

Cette branche conserve intégralement plusieurs corrections de petits problèmes d'expérience amont, validées par des tests de régression :

| Problème | Commit de correction amont | Périmètre impacté |
|------|-----------------|----------|
| 📋 **Contenu copié-collé corrompu** — Le contenu du prompt collé par l'utilisateur est incorrectement tronqué ou perd des caractères dans le TUI | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | Expérience de saisie TUI |
| 📐 **Mise en page non actualisée après collage** — Après collage d'un texte long, la hauteur de la zone de prompt ne s'ajuste pas automatiquement, provoquant un effet visuel de troncature | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | Expérience de saisie TUI |
| 📎 **Absence de repli en cas d'échec d'écriture dans le presse-papiers** — Si l'API `navigator.clipboard` échoue (environnement HTTP, etc.), l'opération de copie échoue directement | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Compatibilité multi-navigateur |
| 🎨 **Contraste insuffisant de la couleur de premier plan du badge de collage** — Le texte du badge récapitulatif de l'opération de collage est difficilement lisible dans certains thèmes | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | Expérience visuelle TUI |
| 📏 **Estimation de la largeur des caractères CJK / est-asiatiques** — La largeur d'affichage des emoji, caractères pleine chasse, sinogrammes et autres caractères est-asiatiques ne correspond pas à l'occupation réelle, causant un décalage du curseur | Intégré au système de correction de segmentation CJK | Alignement des caractères TUI |
| ⌨️ **Tremblement de la fenêtre candidate IME** — Lors de l'activation de l'IME chinois/japonais, tremblement du curseur + délai d'insertion des caractères | Correctif local de contournement | Expérience de saisie TUI |

> Cette branche ne réinvente pas la roue : les problèmes déjà corrigés en amont sont synchronisés lors des fusions de la branche `stable` ; cette branche se concentre sur la correction des problèmes liés aux fonctionnalités chinoises et au workflow DAG non encore traités par l'amont.

## Fonctionnalités préservées de l'amont (MIT)

Toutes les fonctionnalités suivantes proviennent littéralement du dépôt amont opencode (sous licence MIT) ; ce fork n'y apporte aucune modification fonctionnelle.

### Application de bureau (BÊTA)

Également disponible en tant qu'application de bureau. Téléchargez depuis la [page des versions](https://github.com/anomalyco/opencode/releases) ou [opencode.ai/download](https://opencode.ai/download).

| Plateforme               | Fichier                                  |
| ------------------------ | ---------------------------------------- |
| macOS (Apple Silicon)    | `opencode-desktop-darwin-aarch64.dmg`    |
| macOS (Intel)            | `opencode-desktop-darwin-x64.dmg`        |
| Windows                  | `opencode-desktop-windows-x64.exe`       |
| Linux                    | `.deb`, `.rpm` ou AppImage               |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agents

OpenCode est livré avec deux agents, commutables à l'aide de la touche `Tab` :

- **build** — mode par défaut, permissions complètes, pour le travail de développement
- **plan** — mode lecture seule, pour l'analyse et l'exploration de code
  - refuse la modification de fichiers par défaut
  - demande confirmation avant d'exécuter des commandes bash
  - pratique pour explorer des bases de code peu familières ou planifier des modifications

Un sous-agent **general** est également inclus pour la recherche complexe et les tâches multi-étapes ; il peut être invoqué en ligne avec `@general`.

En savoir plus sur les [Agents](https://opencode.ai/docs/agents).

### API Hooks de ClaudeCode

Ce fork préserve intégralement le système Hooks API en amont ainsi que ses 22 événements déclenchés à l'exécution. Les hooks sont enregistrés sous le champ `hooks` du fichier de configuration par nom d'événement et prennent en charge cinq types d'exécution : `command`, `mcp`, `http`, `prompt`, `agent`. Ils communiquent via des enveloppes JSON sur stdin/stdout.

Voir [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) pour le protocole complet.

Pour le tableau complet des événements, consulter le [document de conservation des fonctionnalités amont](./docs/readmes/upstream-features.md).

## Licence et attribution

Ce dépôt utilise un **modèle de licence mixte** :

| Contenu                                                              | Licence       | Localisation                                                            |
|----------------------------------------------------------------------|---------------|------------------------------------------------------------------------|
| Code amont opencode (la grande majorité des fichiers)                | **MIT**       | [`LICENSE`](./LICENSE)                                                  |
| Moteur de workflow DAG auto-développé (`packages/opencode/src/dag/` et outils / modèles / docs associés) | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Voir le fichier [`NOTICE`](./NOTICE) pour la description complète des limites de licence.

### 🔒 Déclaration de licence obligatoire AGPL v3 (contrainte stricte de cette branche)

**Politique de développement secondaire de l'auteur de ce dépôt :**

1. **Le code développé en interne doit utiliser la GNU AGPL v3** — Tout code ajouté, réécrit ou significativement modifié par l'auteur de cette branche **doit** être placé sous la licence GNU Affero General Public License v3 ou supérieure (AGPL-3.0-or-later)
2. **Exigence de réciprocité de l'AGPL** — Tout projet utilisant, modifiant ou dérivant des modules AGPL-3.0 (moteur de workflow DAG, etc.) **doit ouvrir l'intégralité de son code source sous AGPL-3.0** et doit permettre l'accès aux utilisateurs finaux
3. **Obligation d'ouverture du code pour le SaaS** — Si vous déployez ce projet ou une œuvre dérivée en tant que service réseau (SaaS / plateforme cloud), vous **devez fournir un lien de téléchargement du code source complet à tous les utilisateurs du service** (c'est la clause clé de l'AGPL qui la distingue de la GPL, §13)
4. **Préservation de la paternité** — Les mentions de l'auteur original, les notifications de copyright, les informations d'attribution dans le fichier NOTICE doivent être conservées

> ⚖️ **Pourquoi l'AGPL ?** L'auteur estime que la valeur du logiciel libre repose sur la collaboration continue. L'AGPL empêche la "SaaS-ification propriétaire" qui nuit à la communauté open source — tout utilisateur commercial bénéficiant de ce projet doit contribuer en retour à la communauté.

**Les parties sous licence MIT ne sont pas soumises à cette clause**, elles restent sous le contrôle exclusif de l'équipe opencode amont.

### Relation avec l'équipe opencode d'origine

- ✅ Ce projet est **basé sur** le code amont [opencode](https://github.com/sst/opencode)
- ❌ Ce projet n'a **aucune affiliation ni autorisation** avec l'équipe officielle opencode (sst / anomalyco)
- ❌ Ce projet n'est pas une version officielle d'opencode et ne fournit pas d'engagement de support pour la version amont officielle
- ❌ **L'équipe officielle OpenCode ne fournit aucun support technique, garantie ni approbation pour cette branche** (conformément à l'exigence d'attribution explicite du README amont)
- ✅ Le moteur de workflow DAG, les corrections des fonctionnalités chinoises et autres améliorations de ce projet sont maintenus indépendamment par l'auteur
- ✅ L'attribution du code MIT amont est intégralement conservée, les mentions d'auteur et de copyright n'ont pas été altérées

Si vous avez besoin d'utiliser la version officielle d'opencode, veuillez consulter https://opencode.ai ou https://github.com/sst/opencode.

## Index de la documentation

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Documentation complète de Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Journal des corrections liées à la langue chinoise
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Conservation des fonctionnalités amont d'opencode
- [`NOTICE`](./NOTICE) — Limites de licence et attributions
- [`AGENTS.md`](./AGENTS.md) — Guide du contributeur et développement secondaire

## Contribuer

Lisez [`CONTRIBUTING.md`](./CONTRIBUTING.md) avant d'ouvrir une PR.

### Développer sur la base de ce fork

Si vous utilisez « opencode » dans le nom de votre projet (par ex. « opencode-dashboard » ou « opencode-mobile »), veuillez indiquer dans votre README que votre projet n'est ni officiellement développé par, ni affilié à, l'équipe OpenCode ou l'auteur de ce fork.

## FAQ

### En quoi cela diffère-t-il de Claude Code ?

Fonctionnellement similaire, mais les principales différences sont :

- 100 % open source
- Indépendant du fournisseur — nous recommandons [OpenCode Zen](https://opencode.ai/zen), mais fonctionne également avec Claude, OpenAI, Google ou des modèles en local
- Prise en charge LSP intégrée
- Axé sur l'interface en terminal (TUI)
- Architecture client/serveur — exécution locale, pilotage à distance depuis un appareil mobile

### En quoi cela diffère-t-il de la version officielle d'opencode ?

- Ajout du moteur Harness-DAG-Workflow (AGPL-3.0)
- Débogage continu des cas limites liés à la langue chinoise
- Maintenance indépendante, découplée du rythme de publication en amont

## Communauté

- 📖 [Communauté amont d'opencode](https://opencode.ai)
- 📝 [Issues de ce fork](./issues) (signalements de bogues et suggestions de fonctionnalités)
