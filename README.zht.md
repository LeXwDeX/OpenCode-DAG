<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.zht.md"><b>繁體中文</b></a> ·
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

> **[opencode](https://github.com/anomalyco/opencode) 的增強版 fork，內建生產級 DAG 工作流引擎，用於多智能體編排。**

基於 MIT 授權的 [opencode](https://github.com/anomalyco/opencode) 終端 AI 智能體建構。**與 OpenCode 團隊無任何隸屬或背書關係。**

---

## 分支狀態

| 分支 | 基線 | 內容 | 狀態 |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + 工具最佳化 | ✅ **穩定** |
| **`dag-branch`** | main + DAG | DAG 工作流引擎（114 files） | 🔧 **開發中** —— 適配 v1.17.11 API 中 |

> [!IMPORTANT]
> **DAG 工作流引擎正在從 v1.15.10 移植**到 v1.17.11 程式碼庫。
> 它位於 `dag-branch` 上，**目前尚不可用**。`main` 分支已完全可用，
> 包含 Hooks、Goal 自動迴圈和工具例外暴露——全部為生產就緒狀態。

---

## 本 fork 的獨特之處

### 📌 `main` 上的穩定功能

#### Hooks API（26 events × 5 execution types）

完整的 Claude Code hooks 協定相容性：`command`、`mcp`、`http`、`prompt`、`agent` 五種 hook 類型，共 26 個 hook 事件，涵蓋 `PreToolUse`、`PostToolUse`、`SessionStart`、`PermissionRequest`、`WorktreeCreate` 等。Hooks 從全域 / 專案 / worktree 的 `hooks.json` 鏈中載入，也可在執行時透過 HTTP API 按工作階段註冊；可選的工作區信任閘道（`requireTrust` + `/trust` 指令）將 hook 執行限制在你已核准的目錄內。

詳見 [hooks 參考](./packages/core/src/plugin/skill/configure-hooks.md)。

#### Goal 自動迴圈

一個自主智能體迴圈，持續驅動智能體朝使用者定義的目標推進。LLM 評判器在每個回合後判斷目標是否已達成或是否需要更多回合，整個過程在可設定的回合預算內執行。`/goal <target>` 設定目標，`/subgoal` 新增子目標，`/goal resume` 繼續一個暫停的目標。

#### 工具例外暴露

- **JSON 修復**：`safeParseJson` + `fixJsonUnicodeEscapes` —— 修復 LLM 產生的 JSON 中損壞的多位元組 Unicode 跳脫
- **Question 工具校驗**：結構化的錯誤格式化，帶欄位級提示和正確呼叫範例
- **工具描述**：擴充了 `question`、`task`、`skill`、`webfetch`、`websearch` 的 `.txt` 文件，新增 Parameters + Returns 章節
- **Shell 管線修復**：所有 `ChildProcess.make` 呼叫使用 `stdout/stderr: "pipe"` + reader fiber 優雅排空

### 🔧 `dag-branch` 上的開發中功能

#### DAG 工作流引擎（AGPL-3.0）

一個**有向無環圖（DAG）工作流引擎**，讓 LLM 智能體在單一工作階段內編排複雜的多節點並行任務。

> ⚠️ **狀態**：從 v1.15.10 fork 原樣複製（114 files）。217 個型別錯誤待 API 適配（將同步 `Database.use` → 基於 Effect 的 `Database.Service`、`Bus` → `EventV2Bridge` 等）。尚不可編譯。

| 能力 | 描述 |
|---|---|
| **自動排程** | 依相依順序生成子智能體，盡可能並行 |
| **動態重規劃** | 執行中新增/刪除/更新節點並調整並行度 |
| **狀態機完整性** | 四條鐵律：禁止繞過狀態機、終態不可逆、事件必須廣播、先持久化再變更 |
| **終端 TUI** | 完整的 DAG 控制面板，帶區塊字元拓撲圖、樹狀檢視、節點對話框、即時更新 |
| **崩潰復原** | 重啟時偵測並復原孤立的執行中工作流 |
| **條件分支** | 節點可依據上游輸出有條件地執行或跳過 |
| **子 DAG 巢狀** | `dag` worker 類型生成遞迴子工作流（max depth 3） |
| **持久化稽核** | 6-table SQLite schema，所有狀態轉換可追溯 |

### CJK 與在地化修復

針對中文/日文/韓文文字處理的全面修復：分詞、全形標點、檔案路徑、終端 UI 中的 IME 輸入。詳見[修復清單](./docs/localization/zh-hans-fixes.md)。

### 雙重隔離：Sandbox + Worktree

- **Sandbox** —— 帶 LSP 診斷的暫存目錄，用於安全的程式碼實驗
- **Worktree** —— 每個工作流一個 `git worktree`，實現並行多智能體編輯隔離

---

## 安裝

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> 安裝前請移除低於 0.1.x 的舊版本。

---

## 保留上游全部能力 —— 並提供更多

所有上游 MIT 授權的能力均完整保留：

- **桌面應用**（macOS / Windows / Linux）—— 從 [releases](https://github.com/anomalyco/opencode/releases) 下載
- **Build 與 Plan 智能體** —— 用 `Tab` 在完全存取和唯讀模式間切換
- **多 Provider** —— Claude、OpenAI、Google、本地模型，透過 [OpenCode Zen](https://opencode.ai/zen)
- **內建 LSP** —— 來自語言伺服器的即時診斷
- **用戶端/伺服器架構** —— 本地執行，從行動裝置遠端驅動

本 fork 在此基礎上新增了 DAG 引擎、CJK 修復、sandbox 編碼工作區和目標追蹤——且不破壞任何現有功能。

---

## 授權

本倉庫採用**混合授權模型**：

| 內容 | 授權 | 位置 |
|---------|---------|----------|
| 上游 opencode 程式碼（絕大多數） | **MIT** | [`LICENSE`](./LICENSE) |
| 自研 DAG 工作流引擎 | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

完整的邊界詳情見 [`NOTICE`](./NOTICE)。

> ⚖️ **為何用 AGPL？** DAG 引擎是核心差異化成果。AGPL 確保任何衍生品——包括 SaaS 部署——都必須回饋開源。

---

## 文件

- [`docs/harness-dag.md`](./docs/harness-dag.md) —— DAG 引擎架構與用法
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) —— CJK 修復目錄
- [`NOTICE`](./NOTICE) —— 授權邊界與歸屬
- [`AGENTS.md`](./AGENTS.md) —— 貢獻與開發指南

## 社群

- 📖 [上游 opencode 社群](https://opencode.ai)
- 📝 [Fork issue 追蹤](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
