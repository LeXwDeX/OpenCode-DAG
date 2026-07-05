<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
-->

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.zht.md">繁體中文</a> ·
  <a href="./README.ar.md"><b>العربية</b></a> ·
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

> **نسخة محسّنة من [opencode](https://github.com/anomalyco/opencode) مزوّدة بمحرك سير عمل DAG جاه للإنتاج لتنسيق الوكلاء متعددين (multi-agent orchestration).**

بُنيت هذه النسخة فوق وكيل الذكاء الاصطناعي الطرفي [opencode](https://github.com/anomalyco/opencode) المرخّص بـ MIT. **وهي ليست تابعة أو معتمدة من فريق OpenCode.**

---

## حالة الفروع (Branch Status)

| الفرع | الأساس | المحتوى | الحالة |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + تحسين الأدوات | ✅ **مستقر** |
| **`dag-branch`** | main + DAG | محرك سير عمل DAG (114 ملفًا) | 🔧 **قيد التطوير** — قيد التكيّف مع واجهات v1.17.11 |

> [!IMPORTANT]
> **جارٍ حاليًا نقل محرك سير عمل DAG** من الإصدار v1.15.10 إلى قاعدة الشيفرة v1.17.11.
> يقع على الفرع `dag-branch` وهو **غير فعال بعد**. أما الفرع `main` فقابل للاستخدام بالكامل
> مع Hooks، والحلقة التلقائية لـ Goal، وكشف استثناءات الأدوات — جميعها جاهزة للإنتاج.

---

## ما الذي يميّز هذه النسخة (Fork)

### 📌 مستقر على `main`

#### واجهة Hooks API (26 حدثًا × 5 أنواع تنفيذ)

توافق كامل مع بروتوكول Hooks الخاص بـ Claude Code: أنواع الـ hooks `command` و `mcp` و `http` و `prompt` و `agent` مع 26 حدث hook تشمل `PreToolUse` و `PostToolUse` و `SessionStart` و `PermissionRequest` و `WorktreeCreate` وغيرها. تُحمَّل الـ hooks من سلسلة `hooks.json` شاملة / مشروع / worktree، أو يمكن تسجيلها لكل جلسة في وقت التشغيل عبر HTTP API؛ ويُقيّد gating الثقة الاختياري للـ workspace (عبر `requireTrust` وأمر `/trust`) تنفيذ الـ hooks على الأدلة التي وافقت عليها فقط.

اطّلع على [مرجع hooks](./packages/core/src/plugin/skill/configure-hooks.md).

#### الحلقة التلقائية لـ Goal

حلقة وكيل ذاتية تعمل باستمرار لدفع الوكيل نحو هدف يحدّده المستخدم. يقرّر حكم LLM بعد كل دورة ما إذا كان الهدف قد تحقّق أو يحتاج إلى مزيد من الدورات، ضمن ميزانية أدوار قابلة للضبط. استخدم `/goal <target>` للتعيين، و`/subgoal` لإضافة أهداف فرعية، و`/goal resume` لاستئناف هدف متوقف.

#### كشف استثناءات الأدوات (Tools Exception Exposure)

- **إصلاح JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — يصلح تهريب Unicode متعدد البايتات المعطوب في JSON المُولّد بواسطة LLM
- **التحقق من أداة السؤال**: تنسيق أخطاء منظم مع تلميحات على مستوى الحقل وأمثلة على الاستدعاء الصحيح
- **أوصاف الأدوات**: توثيق `.txt` موسّع لأدوات `question` و `task` و `skill` و `webfetch` و `websearch` مع أقسام Parameters و Returns
- **إصلاح shell pipe**: `stdout/stderr: "pipe"` في جميع استدعاءات `ChildProcess.make` + تفريغ مهذّب لليف القارئ (reader fiber grace drain)

### 🔧 قيد التطوير على `dag-branch`

#### محرك سير عمل DAG (AGPL-3.0)

**محرك سير عمل موجّه غير دوري (DAG)** يتيح لوكلاء LLM تنسيق مهام معقّدة متعددة العُقد ومتوازية ضمن جلسة واحدة.

> ⚠️ **الحالة**: نُسخ خامًا من النسخة v1.15.10 (114 ملفًا). ينتظر 217 خطأ نوع (type errors) تكييف الـ APIs (مزامنة `Database.use` → `Database.Service` المبني على Effect، و `Bus` → `EventV2Bridge`، إلخ.). غير قابل للترجمة (compilation) بعد.

| القدرة | الوصف |
|---|---|
| **الجدولة التلقائية** | يُنشئ وكلاء فرعيين بناءً على ترتيب الاعتماديات، بالتوازي حيثما أمكن |
| **إعادة التخطيط الديناميكي** | إضافة/إزالة/تحديث العُقد وضبط التزامن أثناء التشغيل |
| **سلامة آلة الحالة** | أربع قواعد ذهبية: يُمنع تجاوز آلة الحالة، الحالات النهائية لا رجعة فيها، يجب بث الأحداث، الاستمرار قبل التعديل |
| **TUI طرفية** | لوحة تحكم DAG كاملة مع خريطة طبولوجيا بأحرف block، وعرض شجري، وحوارات عُقد، وتحديثات فورية |
| **الاسترجاع بعد الانهيار** | يكتشف ويستأنف سير العمل اليتيم قيد التشغيل عند إعادة التشغيل |
| **التفرع الشرطي** | يمكن للعُقد التنفيذ أو التخطي شرطيًا بناءً على المخرجات المنبعثة |
| **تداخل Sub-DAG** | نوع العامل `dag` يُنشئ سير عمل فرعي متكرر (أقصى عمق 3) |
| **تدقيق دائم** | مخطط SQLite من 6 جداول، جميع انتقالات الحالة قابلة للتتبّع |

### إصلاحات CJK والتوطين

إصلاحات شاملة لمعالجة النصوص الصينية/اليابانية/الكورية: الترميز (tokenization)، علامات الترقيم كاملة العرض، مسارات الملفات، إدخال IME في واجهة الطرفية. اطّلع على [قائمة الإصلاحات](./docs/localization/zh-hans-fixes.md).

### عزل مزدوج: Sandbox + Worktree

- **Sandbox** — أدلة مؤقتة عابرة مع تشخيصات LSP لتجارب الشيفرة الآمنة
- **Worktree** — عزل `git worktree` لكل سير عمل لتحرير متعدد الوكلاء بالتوازي

---

## التثبيت (Install)

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> أزِل الإصدارات الأقدم من 0.1.x قبل التثبيت.

---

## احتفظ بالأصل — والمزيد

جميع قدرات الأصل المرخّص بـ MIT محفوظة بالكامل:

- **تطبيق سطح المكتب** (macOS / Windows / Linux) — حمّله من [الإصدارات](https://github.com/anomalyco/opencode/releases)
- **وكلاء Build & Plan** — استخدم `Tab` للتبديل بين وضعي الوصول الكامل والقراءة فقط
- **متعدد المزوّدين** — Claude و OpenAI و Google والنماذج المحلية عبر [OpenCode Zen](https://opencode.ai/zen)
- **LSP مدمج** — تشخيصات فورية من خوادم اللغات
- **معمارية client/server** — تشغيل محلي، تحكّم عن بُعد من الجوال

تضيف هذه النسخة محرك DAG، وإصلاحات CJK، ومساحة عمل sandbox للبرمجة، وتتبّع الأهداف فوق ذلك — دون كسر أي شيء.

---

## الترخيص (License)

يستخدم هذا المستودع **نموذج ترخيص مختلط**:

| المحتوى | الترخيص | الموقع |
|---------|---------|----------|
| شيفرة opencode الأصلية (الغالبية العظمى) | **MIT** | [`LICENSE`](./LICENSE) |
| محرك سير عمل DAG المطوّر ذاتيًا | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

التفاصيل الكاملة للحدود في [`NOTICE`](./NOTICE).

> ⚖️ **لماذا AGPL؟** محرك DAG هو العمل التمايزي الأساسي. يضمن AGPL أن أي اشتقاق — بما في ذلك عمليات نشر SaaS — يجب أن يردّ المساهمة.

---

## الوثائق (Docs)

- [`docs/harness-dag.md`](./docs/harness-dag.md) — بنية محرك DAG واستخدامه
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — فهرس إصلاحات CJK
- [`NOTICE`](./NOTICE) — حدود الترخيص والإسناد
- [`AGENTS.md`](./AGENTS.md) — دليل المساهمة والتطوير

## المجتمع (Community)

- 📖 [مجتمع opencode الأصلي](https://opencode.ai)
- 📝 [متتبّع مشاكل النسخة](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
