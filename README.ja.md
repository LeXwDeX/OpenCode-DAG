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
  <a href="./README.ja.md"><b>日本語</b></a> ·
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

> **[opencode](https://github.com/anomalyco/opencode) の拡張 fork で、マルチエージェントオーケストレーション向けのプロダクショングレードな DAG ワークフローエンジンを内蔵しています。**

MIT ライセンスの [opencode](https://github.com/anomalyco/opencode) ターミナル AI エージェントをベースに構築されています。**OpenCode チームとは一切の提携・承認関係はありません。**

---

## ブランチ状況

| ブランチ | ベース | 内容 | 状態 |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + ツール最適化 | ✅ **安定** |
| **`dag-branch`** | main + DAG | DAG ワークフローエンジン（114 files） | 🔧 **開発中** —— v1.17.11 API への適応作業中 |

> [!IMPORTANT]
> **DAG ワークフローエンジンは現在 v1.15.10 から v1.17.11** コードベースへ**移植中**です。
> `dag-branch` に存在し、**まだ機能していません**。`main` ブランチは、Hooks、Goal 自動ループ、
> ツール例外公開を備え、完全に利用可能です——いずれもプロダクション対応です。

---

## この fork の違い

### 📌 `main` の安定機能

#### Hooks API（26 events × 5 execution types）

Claude Code hooks プロトコルとの完全な互換性：`command`、`mcp`、`http`、`prompt`、`agent` の 5 種類の hook タイプに、`PreToolUse`、`PostToolUse`、`SessionStart`、`PermissionRequest`、`WorktreeCreate` など 26 の hook イベントを含みます。Hooks はグローバル / プロジェクト / worktree の `hooks.json` チェインから読み込まれるほか、HTTP API 経由でセッション単位で実行時に登録することも可能です。オプションのワークスペース信頼ゲート（`requireTrust` + `/trust` コマンド）により、承認済みディレクトリのみで hook の実行を制限できます。

詳細は [hooks リファレンス](./packages/core/src/plugin/skill/configure-hooks.md) を参照してください。

#### Goal 自動ループ

ユーザー定義の目標に向けてエージェントを継続的に駆動する自律型エージェントループです。LLM 審査者が各ターン終了後に目標達成かさらなるターンが必要かを判断し、設定可能なターン予算内で実行されます。`/goal <target>` で目標を設定、`/subgoal` でサブ目標を追加、`/goal resume` で一時停止した目標を再開します。

#### ツール例外公開

- **JSON 修復**：`safeParseJson` + `fixJsonUnicodeEscapes` —— LLM 生成 JSON 内の壊れたマルチバイト Unicode エスケープを修復
- **Question ツールのバリデーション**：フィールドレベルのヒントと正しい呼び出し例を含む構造化エラーフォーマット
- **ツール説明**：`question`、`task`、`skill`、`webfetch`、`websearch` の `.txt` ドキュメントを拡充し、Parameters + Returns セクションを追加
- **シェルパイプ修正**：すべての `ChildProcess.make` 呼び出しで `stdout/stderr: "pipe"` + reader ファイバーのグレースフル排出

### 🔧 `dag-branch` の開発中機能

#### DAG ワークフローエンジン（AGPL-3.0）

**有向非巡回グラフ（DAG）ワークフローエンジン**により、LLM エージェントが単一セッション内で複雑なマルチノード並列タスクを編成できます。

> ⚠️ **状態**：v1.15.10 fork からそのままコピー（114 files）。API 適応待ちの型エラー 217 件（同期 `Database.use` → Effect ベースの `Database.Service`、`Bus` → `EventV2Bridge` など）。まだコンパイルできません。

| 機能 | 説明 |
|---|---|
| **自動スケジューリング** | 依存順に子エージェントを生成し、可能な限り並列実行 |
| **動的再計画** | 実行中にノードの追加/削除/更新と並行度の調整が可能 |
| **状態機械の完全性** | 4 つの鉄則：状態機械のバイパス禁止、終端状態の不可逆、イベントのブロードキャスト必須、変更前の永続化 |
| **ターミナル TUI** | ブロック文字トポロジーマップ、ツリービュー、ノードダイアログ、リアルタイム更新を備えた完全な DAG コントロールパネル |
| **クラッシュリカバリ** | 再起動時に孤立した実行中ワークフローを検出して再開 |
| **条件分岐** | 上流の出力に基づきノードを条件的に実行またはスキップ可能 |
| **サブ DAG ネスト** | `dag` worker タイプが再帰的サブワークフローを生成（max depth 3） |
| **永続監査** | 6-table SQLite schema、すべての状態遷移が追跡可能 |

### CJK およびローカライズ修正

中国語/日本語/韓国語のテキスト処理に関する包括的な修正：トークン化、全角句読点、ファイルパス、ターミナル UI での IME 入力。詳細は[修正一覧](./docs/localization/zh-hans-fixes.md) を参照してください。

### 二重の隔離：Sandbox + Worktree

- **Sandbox** —— LSP 診断付きの一時ディレクトリで、安全なコード実験を実現
- **Worktree** —— ワークフローごとに `git worktree` を割り当て、並列マルチエージェント編集を隔離

---

## インストール

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> インストール前に 0.1.x 未満の旧バージョンを削除してください。

---

## 上流の機能をすべて保持 —— さらに追加

上流の MIT ライセンス機能はすべて完全に保持されています：

- **デスクトップアプリ**（macOS / Windows / Linux）—— [releases](https://github.com/anomalyco/opencode/releases) からダウンロード
- **Build & Plan エージェント** —— `Tab` でフルアクセスと読み取り専用モードを切り替え
- **マルチプロバイダ** —— Claude、OpenAI、Google、ローカルモデルを [OpenCode Zen](https://opencode.ai/zen) 経由で利用
- **組み込み LSP** —— 言語サーバーからのリアルタイム診断
- **クライアント/サーバーアーキテクチャ** —— ローカルで実行、モバイルからリモート操作

本 fork は、この上に DAG エンジン、CJK 修正、sandbox コーディングワークスペース、ゴールトラッキングを追加しています——既存の機能を壊すことなく。

---

## ライセンス

本リポジトリは**混合ライセンスモデル**を採用しています：

| 内容 | ライセンス | 場所 |
|---------|---------|----------|
| 上流 opencode コード（大部分） | **MIT** | [`LICENSE`](./LICENSE) |
| 自社開発 DAG ワークフローエンジン | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

境界の完全な詳細は [`NOTICE`](./NOTICE) に記載されています。

> ⚖️ **なぜ AGPL なのか？** DAG エンジンは中核となる差別化成果物です。AGPL により、派生物——SaaS デプロイを含む——は必ずコミュニティに還元しなければなりません。

---

## ドキュメント

- [`docs/harness-dag.md`](./docs/harness-dag.md) —— DAG エンジンのアーキテクチャと使い方
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) —— CJK 修正カタログ
- [`NOTICE`](./NOTICE) —— ライセンス境界と帰属
- [`AGENTS.md`](./AGENTS.md) —— コントリビューションと開発ガイド

## コミュニティ

- 📖 [上流 opencode コミュニティ](https://opencode.ai)
- 📝 [Fork の issue トラッカー](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
