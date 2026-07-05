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
  <a href="./README.bn.md"><b>বাংলা</b></a>
</p>

# OpenCode-DAG

> **[opencode](https://github.com/anomalyco/opencode)-এর একটি উন্নত fork, মাল্টি-এজেন্ট অর্কেস্ট্রেশনের জন্য একটি প্রোডাকশন-গ্রেড DAG ওয়ার্কফ্লো ইঞ্জিন সহ।**

MIT-লাইসেন্সপ্রাপ্ত টার্মিনাল AI এজেন্ট [opencode](https://github.com/anomalyco/opencode)-এর উপর ভিত্তি করে তৈরি। **OpenCode টিমের সাথে অনুমোদিত বা সম্পর্কিত নয়।**

---

## শাখা অবস্থা (Branch Status)

| শাখা | ভিত্তি | বিষয়বস্তু | অবস্থা |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Tools অপ্টিমাইজেশন | ✅ **স্থিতিশীল** |
| **`dag-branch`** | main + DAG | DAG ওয়ার্কফ্লো ইঞ্জিন (১১৪টি ফাইল) | 🔧 **উন্নয়নাধীন** — v1.17.11 API-গুলির সাথে মানিয়ে নেওয়া হচ্ছে |

> [!IMPORTANT]
> **DAG ওয়ার্কফ্লো ইঞ্জিনটি বর্তমানে পোর্ট করা হচ্ছে** v1.15.10 থেকে v1.17.11 কোডবেসে।
> এটি `dag-branch`-এ অবস্থিত এবং **এখনও কার্যকর নয়**। `main` শাখাটি সম্পূর্ণরূপে ব্যবহারযোগ্য
> Hooks, Goal অটো-লুপ এবং Tools এক্সেপশন এক্সপোজার সহ — সবই প্রোডাকশন-প্রস্তুত।

---

## এই fork-কে আলাদা করে যা তোলে

### 📌 `main`-এ স্থিতিশীল

#### Hooks API (২৬টি ইভেন্ট × ৫টি এক্সিকিউশন প্রকার)

Claude Code-এর hooks প্রোটোকলের সাথে সম্পূর্ণ সামঞ্জস্য: `command`, `mcp`, `http`, `prompt`, `agent` হুক প্রকার, `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` সহ ২৬টি হুক ইভেন্ট এবং আরও অনেক কিছু। Hooks একটি global / project / worktree `hooks.json` চেইন থেকে লোড হয়, অথবা রানটাইমে HTTP API-এর মাধ্যমে প্রতি-সেশন নিবন্ধন করা যেতে পারে; ঐচ্ছিক workspace-trust gating (`requireTrust` + `/trust` কমান্ড) হুক এক্সিকিউশন কেবল আপনার অনুমোদিত ডিরেক্টরিগুলিতেই সীমাবদ্ধ রাখে।

[hooks রেফারেন্স](./packages/core/src/plugin/skill/configure-hooks.md) দেখুন।

#### Goal অটো-লুপ

একটি স্বায়ত্তশাসিত এজেন্ট লুপ যা একটি ব্যবহারকারী-নির্ধারিত লক্ষ্যের দিকে এজেন্টকে ক্রমাগত এগিয়ে নিয়ে যায়। একটি LLM judge প্রতিটি টার্নের পরে সিদ্ধান্ত নেয় লক্ষ্যটি অর্জিত হয়েছে কিনা বা আরও টার্ন প্রয়োজন কিনা, একটি কনফিগারযোগ্য টার্ন বাজেটের মধ্যে। সেট করতে `/goal <target>`, সাব-লক্ষ্য যোগ করতে `/subgoal`, এবং বিরতির লক্ষ্য চালিয়ে যেতে `/goal resume` ব্যবহার করুন।

#### Tools এক্সেপশন এক্সপোজার

- **JSON মেরামত**: `safeParseJson` + `fixJsonUnicodeEscapes` — LLM-উৎপাদিত JSON-এ ভাঙা মাল্টি-বাইট Unicode escape মেরামত করে
- **Question tool যাচাইকরণ**: ফিল্ড-স্তরের ইঙ্গিত এবং সঠিক-কলের উদাহরণ সহ কাঠামোগত ত্রুটি ফরম্যাটিং
- **Tool বিবরণ**: `question`, `task`, `skill`, `webfetch`, `websearch`-এর জন্য প্রসারিত `.txt` ডকস Parameters + Returns বিভাগ সহ
- **Shell pipe সমাধান**: সব `ChildProcess.make` কলে `stdout/stderr: "pipe"` + reader fiber grace drain

### 🔧 `dag-branch`-এ উন্নয়নাধীন

#### DAG ওয়ার্কফ্লো ইঞ্জিন (AGPL-3.0)

একটি **নির্দেশিত অ্যাসাইক্লিক গ্রাফ (DAG) ওয়ার্কফ্লো ইঞ্জিন** যা LLM এজেন্টদের একটি একক সেশনের মধ্যে জটিল মাল্টি-নোড প্যারালাল টাস্ক অর্কেস্ট্রেট করতে দেয়।

> ⚠️ **অবস্থা**: v1.15.10 fork থেকে অপরিশোধিতভাবে কপি করা (১১৪টি ফাইল)। API অভিযোজনের জন্য ২১৭টি টাইপ ত্রুটি (type errors) অপেক্ষমাণ (sync `Database.use` → Effect-ভিত্তিক `Database.Service`, `Bus` → `EventV2Bridge` ইত্যাদি)। এখনও কম্পাইল করা যাচ্ছে না।

| সক্ষমতা | বিবরণ |
|---|---|
| **অটো-সিডিউলিং** | নির্ভরতার ক্রমানুসারে চাইল্ড এজেন্ট তৈরি করে, যেখানে সম্ভব প্যারালালভাবে |
| **ডায়নামিক রিপ্ল্যানিং** | চালানোর মাঝে নোড যোগ/অপসারণ/আপডেট এবং concurrency সমন্বয় |
| **State machine অখণ্ডতা** | চারটি লৌহনিয়ম: state machine বাইপাস নিষিদ্ধ, টার্মিনাল অবস্থা অপরিবর্তনীয়, ইভেন্ট অবশ্যই ব্রডকাস্ট করতে হবে, mutate-এর আগে persist |
| **টার্মিনাল TUI** | ব্লক-ক্যারেক্টার টপোলজি মানচিত্র, ট্রি ভিউ, নোড ডায়ালগ, রিয়েল-টাইম আপডেট সহ সম্পূর্ণ DAG কন্ট্রোল প্যানেল |
| **ক্র্যাশ রিকভারি** | পুনরায় চালু হলে পরিত্যক্ত চলমান ওয়ার্কফ্লো সনাক্ত করে এবং পুনরায় শুরু করে |
| **কন্ডিশনাল ব্র্যাঞ্চিং** | নোডগুলি আপস্ট্রিম আউটপুটের উপর ভিত্তি করে শর্তসাপেক্ষে এক্সিকিউট বা স্কিপ করতে পারে |
| **Sub-DAG নেস্টিং** | worker type `dag` রিকার্সিভ সাব-ওয়ার্কফ্লো তৈরি করে (max depth 3) |
| **স্থায়ী অডিট** | 6-table SQLite স্কিমা, সমস্ত স্টেট ট্রানজিশন ট্রেসেবল |

### CJK ও লোকালাইজেশন সমাধান

চীনা/জাপানি/কোরিয়ান টেক্সট হ্যান্ডলিংয়ের জন্য ব্যাপক সমাধান: টোকেনাইজেশন, ফুল-উইডথ পাংচুয়েশন, ফাইল পাথ, টার্মিনাল UI-তে IME ইনপুট। [সমাধানের তালিকা](./docs/localization/zh-hans-fixes.md) দেখুন।

### দ্বৈত বিচ্ছিন্নতা: Sandbox + Worktree

- **Sandbox** — নিরাপদ কোড পরীক্ষার জন্য LSP ডায়াগনস্টিক্স সহ ক্ষণস্থায়ী টেম্প ডিরেক্টরি
- **Worktree** — প্যারালাল মাল্টি-এজেন্ট এডিটিংয়ের জন্য প্রতি-ওয়ার্কফ্লো `git worktree` বিচ্ছিন্নতা

---

## ইনস্টল

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> ইনস্টল করার আগে 0.1.x-এর পুরোনো সংস্করণগুলি সরিয়ে দিন।

---

## আপস্ট্রিম রাখুন — এবং আরও

MIT-লাইসেন্সপ্রাপ্ত সমস্ত আপস্ট্রিম সক্ষমতা সম্পূর্ণরূপে সংরক্ষিত:

- **ডেস্কটপ অ্যাপ** (macOS / Windows / Linux) — [releases](https://github.com/anomalyco/opencode/releases) থেকে ডাউনলোড করুন
- **Build & Plan এজেন্ট** — ফুল-অ্যাক্সেস এবং রিড-ওনলি মোডের মধ্যে স্যুইচ করতে `Tab`
- **মাল্টি-প্রোভাইডার** — Claude, OpenAI, Google, [OpenCode Zen](https://opencode.ai/zen)-এর মাধ্যমে local মডেল
- **বিল্ট-ইন LSP** — language server থেকে রিয়েল-টাইম ডায়াগনস্টিক্স
- **ক্লায়েন্ট/সার্ভার আর্কিটেকচার** — লোকালি চালান, মোবাইল থেকে দূরবর্তীভাবে নিয়ন্ত্রণ করুন

এই fork-টি DAG ইঞ্জিন, CJK সমাধান, sandbox কোডিং ওয়ার্কস্পেস এবং গোল ট্র্যাকিং যোগ করে — কিছু না ভেঙে।

---

## লাইসেন্স

এই রিপোজিটরিটি একটি **মিশ্র লাইসেন্স মডেল** ব্যবহার করে:

| বিষয়বস্তু | লাইসেন্স | অবস্থান |
|---------|---------|----------|
| আপস্ট্রিম opencode কোড (বিশাল সংখ্যাগরিষ্ঠ) | **MIT** | [`LICENSE`](./LICENSE) |
| স্ব-উন্নত DAG ওয়ার্কফ্লো ইঞ্জিন | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

সম্পূর্ণ সীমানার বিবরণ [`NOTICE`](./NOTICE)-এ।

> ⚖️ **কেন AGPL?** DAG ইঞ্জিনটি হল মূল পার্থক্যমূলক কাজ। AGPL নিশ্চিত করে যে যেকোনো ডেরিভেটিভ — SaaS ডিপ্লয়মেন্ট সহ — অবশ্যই অবদান ফেরত দিতে হবে।

---

## ডকস

- [`docs/harness-dag.md`](./docs/harness-dag.md) — DAG ইঞ্জিন আর্কিটেকচার ও ব্যবহার
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — CJK সমাধান ক্যাটালগ
- [`NOTICE`](./NOTICE) — লাইসেন্স সীমানা ও অ্যাট্রিবিউশন
- [`AGENTS.md`](./AGENTS.md) — অবদান ও ডেভেলপমেন্ট গাইড

## কমিউনিটি

- 📖 [আপস্ট্রিম opencode কমিউনিটি](https://opencode.ai)
- 📝 [Fork ইস্যু ট্র্যাকার](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
