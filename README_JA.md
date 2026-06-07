<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 このフォークの著者（帰属については NOTICE ファイルを参照）。
GNU AGPL v3 に基づいてライセンスされています。変更はオープンソース化する必要があります。
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
  <a href="./README_JA.md"><b>日本語</b></a> ·
  <a href="./README_KO.md">한국어</a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode（拡張版）

> **⚠️ 免責事項**：本プロジェクトは [opencode](https://github.com/sst/opencode) の拡張フォークであり、独立した開発者によってメンテナンスされています。OpenCode 公式チームとの**提携、承認、または公式なサポートは一切ありません**。オリジナルプロジェクトは opencode チームにより MIT ライセンスで公開されています。本フォークは上流の MIT ライセンスコードをそのまま維持しつつ、新しい独自のモジュールをより強力なコピーレフトライセンスの下で追加しています。詳細は [NOTICE](./NOTICE) を参照してください。

## 概要

本プロジェクトは上流 `opencode` の**再設計・拡張版**であり、以下の点に注力しています：

- 🔧 **中国語関連のエッジケース修正**：上流バージョンで発見された CJK トークン化・全角句読点・中国語パス・IME 操作に関する問題を修正（[CJK 修正ログ](./docs/localization/zh-hans-fixes.md) を参照）
- 🧩 **本番環境対応の DAG ワークフローエンジンの提供**：自作の [Harness-DAG-Workflow](./docs/harness-dag.md) により、LLM エージェントが単一セッション内で複数ノードの並列タスクをオーケストレーション可能
- 🎯 **上流との互換性の維持**：上流の MIT ライセンスコードには機能的に変更を加えず、ビルドの破壊や API の汚染を行いません

## インストール

```bash
# 直接インストール（YOLO）
curl -fsSL https://opencode.ai/install | bash

# パッケージマネージャー
npm i -g opencode-ai@latest        # bun/pnpm/yarn でも使用可能
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS および Linux（推奨、常に最新版）
brew install opencode              # macOS および Linux（公式 formula、アップデート頻度は低い）
sudo pacman -S opencode            # Arch Linux（安定版）
paru -S opencode-bin               # Arch Linux（AUR より最新版）
mise use -g opencode               # 任意の OS
nix run nixpkgs#opencode           # または github:anomalyco/opencode で最新 dev ブランチを取得
```

> [!TIP]
> インストール前に 0.1.x より前のバージョンを削除してください。

## 本ブランチ独自の機能

本ブランチは上流の opencode を基に構築され、以下の機能を**新規追加**または**大幅強化**しています（詳細は各節を参照）：

| 機能 | 概要 | ライセンス |
|------|------|------|
| 🧩 DAG HARNESS オーケストレーションタスクシステム | LLM エージェントが単一セッション内で複数ノードの並列ワークフローを編成可能にします | AGPL-3.0 |
| 🪝 HOOKS API スーパーセット実装 | 22 種のランタイムイベント × 5 種の実行タイプを備えた完全な Hooks 体系 | MIT + 本ブランチ強化 |
| 🛡️ 軽量 CODING 隔離環境 | Sandbox + Worktree のデュアルトラック隔離実行環境 | MIT + 本ブランチ強化 |
| 🔧 中国語特性デバッグ | CJK トークン化 / 全角句読点 / IME 互換性 / 中国語パス | MIT |
| 🔬 その他の小規模デバッグ | コピー＆ペースト、東アジア言語の幅、中国語出力の切り捨てなど | MIT |

### 🧩 DAG HARNESS オーケストレーションタスクシステム（独自開発モジュール · AGPL-3.0）

旧称 Harness-DAG-Workflow。本番環境レベルの **有向非巡回グラフ（DAG）ワークフローエンジン**であり、LLM エージェントが単一セッション内で複雑な並列タスクを編成できるようにします。中核機能：

- **自動スケジューリング**：ノード間の依存関係に基づいて自動的にサブエージェントを spawn し、並列実行
- **動的再計画**：実行中にリアルタイムでワークフローを replan（ノードの追加・削除・変更、並列上限の調整）
- **鉄の掟の遵守**：ステートマシンは迂回不可、終端状態は不可逆、イベントは必ずブロードキャスト、永続化を優先
- **Slash コマンド統合**：`/dag-ctl` で実行制御、`/dag-worker` でワークフロー設定
- **永続的監査**：SQLite 6 テーブルスキーマ、すべての状態変更が追跡可能

完全なアーキテクチャ設計は [Harness-DAG-Workflow ドキュメント](./docs/harness-dag.md) を、開発ガイドは [AGENTS.md](./packages/opencode/src/dag/AGENTS.md) を参照してください。

> **ライセンス**：本モジュール（[`packages/opencode/src/dag/`](./packages/opencode/src/dag/)、[`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts)、[`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) および関連テンプレート・ドキュメント）は **GNU AGPL v3** ライセンスの下で公開されています——本モジュールを使用する場合、すべての改変をオープンソースにする必要があります。詳細は [NOTICE](./NOTICE) および [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE) を参照してください。

### 🪝 HOOKS API スーパーセット実装

本ブランチは上流の Hooks API 体系を完全に保持し、さらに強化しています：

- **22 種のランタイムトリガーイベント**：`PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 種の実行タイプ**：`command`（シェル）/ `mcp`（MCP ツール）/ `http`（REST）/ `prompt`（単一ターン LLM）/ `agent`（複数ターン LLM）
- **stdin/stdout JSON エンベロープ通信プロトコル**：完全なプロトコルドキュメントは [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) を参照
- **本ブランチの強化**：DAG ワークフローイベントバス統合（`workflow.*` / `node.*` イベント）+ TUI 購読 + HTTP API 転送

### 🛡️ 軽量 CODING 隔離環境

本ブランチはデュアルトラックの隔離実行環境を提供し、エージェント/ユーザーが実際のリポジトリを汚染することなく、安全なサンドボックス内でコードを試せるようにします：

| 隔離階層 | メカニズム | 用途 |
|---------|------|------|
| **Sandbox**（軽量） | 一時ディレクトリ + LSP 診断 + 多言語ツールチェーン（Python/Node/TS/Go/Rust/C/C++） | 単一ファイル/小規模実験のコード試行 |
| **Worktree**（重量） | `git worktree` による独立ブランチ + 独立ファイルシステムビュー | 複数エージェントによる並列編集、大規模リファクタリング |

- 📦 **Sandbox ツール**：`packages/opencode/src/tool/sandbox.ts`、各 sandbox は独立した依存関係キャッシュ（venv / node_modules）を持ち、`ephemeral` ワンショットモードと `background` 非同期長時間タスクをサポート
- 🌳 **DAG Worktree マネージャー**：DAG ワークフロー内で、各並列ノードは自動的に独立した worktree ブランチに割り当てられ、ノード完了後に `git merge` でメインラインに統合

### 🔧 中国語特性デバッグ（修正済みの上流問題）

上流バージョンで中国語使用時に見つかったいくつかの互換性/体験上の問題をデバッグし最適化しました。対象は以下のとおりです：

- **中国語のトークン化とトークンカウント**：特定のトークナイザーにおける CJK 文字の異常処理
- **全角句読点の互換性**：設定解析における全角コロン、引用符、括弧の許容
- **中国語パス処理**：スペースや CJK 文字を含むファイルパスのフック/sandbox 内での正しい受け渡し
- **中国語入力方式（IME）互換性**：IME 候補ウィンドウ表示時の TUI での入力遅延とカーソルのちらつき

 具体的な修正記録とリグレッションテストについては [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) を参照してください。

> 💡 使用中に他の中国語特性の問題を発見した場合は、[issue エリア](./issues) に再現手順を提出してください。継続的にデバッグします。

### 🔬 その他の小規模デバッグ（統合済みの上流修正）

本ブランチは上流のいくつかの小規模な体験問題の修正を完全に保持しており、リグレッションテストにより検証済みです：

| 問題 | 上流修正コミット | 影響範囲 |
|------|-----------------|----------|
| 📋 **コピー＆ペースト内容の破損** — ユーザーが貼り付けたプロンプト内容が TUI で誤って切り捨てられたり文字が欠落する | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI 入力体験 |
| 📐 **貼り付け後のレイアウト未更新** — 長文貼り付け後にプロンプトボックスの高さが自動的に拡張されず、視覚的に切り捨てられる | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI 入力体験 |
| 📎 **クリップボード書き込み失敗時のフォールバックなし** — `navigator.clipboard` API が失敗した場合（HTTP 環境など）、コピー操作が直接エラーになる | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | クロスブラウザ互換性 |
| 🎨 **貼り付けバッジの前景色コントラスト不足** — 貼り付け操作のサマリーバッジが一部のテーマで文字が判読しにくい | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI 視覚体験 |
| 📏 **CJK / 東アジア文字の幅の推定** — 絵文字、全角文字、漢字などの東アジア幅文字の表示幅と実際の占有幅が一致せず、カーソル位置がずれる | CJK トークン化修正体系に統合済み | TUI 文字アライメント |
| ⌨️ **IME 候補ウィンドウのちらつき** — 中国語/日本語入力方式がアクティブなとき、カーソルがちらつき＋文字挿入に遅延が発生 | ローカル回避パッチ | TUI 入力体験 |

> 本ブランチは車輪の再発明をしません：上流で既に修正された問題は `stable` ブランチの合流更新に伴って同期されます；本ブランチは主に上流が未対応の中国語特性や DAG ワークフロー関連の問題をデバッグします。

## 上流から維持されている機能（MIT）

以下の機能はすべて上流の opencode リポジトリ（MIT ライセンス）からそのまま引き継がれており、本フォークは機能的に変更を加えていません。

### デスクトップアプリ（ベータ）

デスクトップアプリとしても利用可能です。[リリースページ](https://github.com/anomalyco/opencode/releases) または [opencode.ai/download](https://opencode.ai/download) からダウンロードしてください。

| プラットフォーム              | ファイル                                   |
| --------------------------- | ----------------------------------------- |
| macOS (Apple Silicon)       | `opencode-desktop-darwin-aarch64.dmg`     |
| macOS (Intel)               | `opencode-desktop-darwin-x64.dmg`         |
| Windows                     | `opencode-desktop-windows-x64.exe`        |
| Linux                       | `.deb`、`.rpm`、または AppImage           |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### エージェント

OpenCode には 2つのエージェントが内蔵されており、`Tab` キーで切り替えできます：

- **build**：デフォルトモード。全権限あり。開発作業向け
- **plan**：読み取り専用モード。コード分析・探索向け
  - デフォルトでファイルの変更を拒否
  - bash コマンド実行前に確認を要求
  - 知らないコードベースの探索や変更の計画に適しています

複雑な検索や複数ステップのタスクには **general** サブエージェントも含まれており、`@general` をインラインで指定して呼び出すことができます。

[エージェント](https://opencode.ai/docs/agents)について詳しくはこちら。

### ClaudeCode Hooks API

本フォークは上流の Hooks API システムおよび実行時にトリガーされる 22 のイベントを完全に維持しています。フックは設定ファイルの `hooks` フィールドにイベント名で登録され、5つの実行タイプ（`command`、`mcp`、`http`、`prompt`、`agent`）をサポートします。stdin/stdout の JSON エンベロープで通信を行います。

完全なプロトコルについては [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) を参照してください。

イベントの全一覧については[上流機能維持ドキュメント](./docs/readmes/upstream-features.md)を参照してください。

## ライセンスと帰属

本リポジトリは**混合ライセンスモデル**を採用しています：

| 内容                                                                          | ライセンス       | 場所                                                                             |
|-------------------------------------------------------------------------------|-----------------|---------------------------------------------------------------------------------|
| 上流 opencode コード（大部分のファイル）                                        | **MIT**          | [`LICENSE`](./LICENSE)                                                           |
| 自作 DAG ワークフローエンジン（`packages/opencode/src/dag/` および関連ツール・テンプレート・ドキュメント）| **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE)        |

完全なライセンス境界の説明は [`NOTICE`](./NOTICE) ファイルを参照してください。

### 🔒 AGPL v3 強制ライセンス声明（本ブランチのハード制約）

**本プロジェクト作者の本リポジトリに対する二次開発ポリシー：**

1. **独自開発コードは GNU AGPL v3 を採用すること** — 本ブランチ作者が新規追加、書き直し、または大幅に変更したコードは、**必ず** GNU Affero General Public License v3 またはそれ以降（AGPL-3.0-or-later）の下で提供されること
2. **AGPL の伝播性要求** — AGPL-3.0 モジュール（DAG ワークフローエンジンなど）を使用、改変、派生させたプロジェクトは、**完全なソースコードを AGPL-3.0 でオープンソース化しなければならず**、かつエンドユーザーへのアクセスを提供しなければならない
3. **SaaS 強制オープンソース化** — 本プロジェクトまたはその派生作品をネットワークサービス（SaaS / クラウドプラットフォーム）として展開する場合、**そのサービスを利用するすべてのユーザーに完全なソースコードのダウンロードリンクを提供しなければならない**（これは AGPL と GPL の核心的な違いであり、§13 に規定）
4. **帰属表示の保持** — 原作者の声明、著作権表示、NOTICE ファイル内の帰属情報を保持しなければならない

> ⚖️ **なぜ AGPL を選んだのか？** 作者は、オープンソースソフトウェアの価値は継続的なコラボレーションにあると考えています。AGPL は「クローズドソース SaaS 化」によるオープンソースコミュニティへの侵害を防ぎます——本プロジェクトの恩恵を受けるすべての商用利用者は、コミュニティに還元しなければなりません。

**MIT ライセンス部分は本条項の制約を受けず**、上流 opencode チームのみが管理します。

### オリジナル opencode チームとの関係

- ✅ 本プロジェクトは [opencode](https://github.com/sst/opencode) の上流コードを**基に**構築されています
- ❌ 本プロジェクトは opencode 公式チーム（sst / anomalyco）と**一切の所属または公認関係がありません**
- ❌ 本プロジェクトは opencode 公式リリース版ではなく、公式上流に対するサポートの約束も行いません
- ❌ **OpenCode 公式チームは本ブランチに対し、いかなる技術サポート、保証、または推奨も提供しません**（上流 README の明確な帰属要求に従う）
- ✅ 本プロジェクトの DAG ワークフローエンジン、中国語特性デバッグなどの強化は作者が独自に保守しています
- ✅ 上流の MIT コードの帰属は完全に保持され、作者および著作権表示は改ざんされていません

opencode 公式バージョンを使用するには、https://opencode.ai または https://github.com/sst/opencode を訪れてください。

## ドキュメント索引

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Harness-DAG-Workflow 完全ドキュメント
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — 中国語関連修正ログ
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — 上流 opencode 機能維持について
- [`NOTICE`](./NOTICE) — ライセンス境界と帰属
- [`AGENTS.md`](./AGENTS.md) — コントリビューター／二次開発ガイド

## コントリビューション

PR を作成する前に [`CONTRIBUTING.md`](./CONTRIBUTING.md) をお読みください。

### 本フォークの上に開発する場合

プロジェクト名に「opencode」（例：「opencode-dashboard」「opencode-mobile」）を使用する場合、README において当該プロジェクトが OpenCode チームまたは本フォークの著者によって公式に開発・提携されたものではないことを明記してください。

## よくある質問（FAQ）

### Claude Code との違いは？

機能的には類似していますが、主な違いは次の通りです：

- 100% オープンソース
- プロバイダーに依存せず（[OpenCode Zen](https://opencode.ai/zen) を推奨しますが、Claude、OpenAI、Google、ローカルモデルでも動作）
- 組み込み LSP サポート
- ターミナル UI（TUI）に注力
- クライアント／サーバーアーキテクチャ — ローカルで実行し、モバイルからリモート操作可能

### 公式 opencode との違いは？

- Harness-DAG-Workflow エンジンの追加（AGPL-3.0）
- 中国語関連のエッジケースの継続的デバッグ
- 独立メンテナ、上流のリリースサイクルに依存しない

## コミュニティ

- 📖 [上流 opencode コミュニティ](https://opencode.ai)
- 📝 [本フォークの issue](./issues)（バグ報告や機能提案）
