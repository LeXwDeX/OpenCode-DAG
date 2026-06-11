<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README_EN.md">English</a> ·
  <a href="./README_AR.md"><b>العربية</b></a> ·
  <a href="./README_BR.md">Português (Brasil)</a> ·
  <a href="./README_BS.md">Bosanski</a> ·
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

> **⚠️ العربية / Arabic — MACHINE TRANSLATION**
> This document was machine-translated from the Chinese primary README.md using DeepSeek V4. No native-speaker review has been performed. For authoritative content, please refer to the [Chinese primary README](./README.md) or the [English README](./README_EN.md). If you'd like to help improve this translation, please open an issue or pull request.

# OpenCode (النسخة المحسّنة)

> **⚠️ إخلاء مسؤولية**: هذا المشروع هو فرع مُحسَّن من [opencode](https://github.com/sst/opencode)، تتم صيانته بواسطة مطور مستقل فوق الإصدار الأصلي. هذا المشروع **غير مرتبط بفريق OpenCode الرسمي** ولا يوجد أي تبعية. المشروع الأصلي منشور من قبل فريق opencode تحت رخصة MIT، وهذا الفرع يحتفظ برخصة MIT الأصلية مع إضافة بعض الوحدات المطورة ذاتياً (انظر [NOTICE](./NOTICE)).

## مقدمة

هذا المشروع هو **نسخة معدّلة ومحسّنة** من الإصدار الرسمي لـ opencode، ويهدف إلى:

- 🔧 **إصلاح مشاكل دعم اللغة الصينية**: معالجة مشاكل التوافق في الإصدار الأصلي المتعلقة بتقسيم الكلمات الصينية، ومعالجة رموز CJK، وعلامات الترقيم بعرض كامل، والمسارات الصينية، والتوافق مع أسلوب الإدخال الصيني (IME) (انظر [قائمة إصلاحات اللغة الصينية](./docs/localization/zh-hans-fixes.md))
- 🧩 **توفير محرك سير عمل DAG بجودة إنتاجية**: وحدة مطورة ذاتياً [Harness-DAG-Workflow](./docs/harness-dag.md)، تُمكّن وكيل LLM من تنظيم وتنفيذ مهام متوازية متعددة العقد في جلسة واحدة
- 🎯 **الحفاظ على التوافق مع المصدر الأصلي**: جميع الشيفرات المرخصة من المصدر الأصلي تحت MIT تبقى كما هي، دون كسر البناء الأصلي أو تلويث واجهة برمجة التطبيقات (API)

## التثبيت

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
> يرجى إزالة الإصدارات الأقدم من 0.1.x قبل التثبيت.


## ميزات هذا الفرع الحصرية

بُني هذا الفرع على opencode الأصلي، مع **إضافات** أو **تحسينات كبيرة** للإمكانيات التالية (لتفاصيل أكثر راجع الأقسام أدناه):

| الميزة | الوصف المختصر | الترخيص |
|------|------|------|
| 🧩 نظام تنظيم المهام DAG HARNESS | تمكين وكيل LLM من تنظيم سير عمل متعدد العقد بالتوازي في جلسة واحدة | AGPL-3.0 |
| 🪝 تنفيذ HOOKS API الموسع | إطار كامل لـ Hooks مع 22 حدث تشغيل × 5 أنواع تنفيذ | MIT + تحسينات هذا الفرع |
| 🛡️ مساحة عزل الترميز خفيفة الوزن | بيئة تشغيل معزولة ثنائية المسار: Sandbox + Worktree | MIT + تحسينات هذا الفرع |
| 🔧 تصحيح أخطاء الميزات الصينية | تجزئة CJK / علامات الترقيم بعرض كامل / توافق IME / المسارات الصينية | MIT |
| 🔬 تصحيحات صغيرة أخرى | النسخ واللصق، عرض اللغات الشرق آسيوية، اقتطاع الناتج الصيني وغيرها | MIT |

### 🧩 نظام تنظيم المهام DAG HARNESS (وحدة مُطورة ذاتياً · AGPL-3.0)

كان يُعرف سابقاً باسم Harness-DAG-Workflow. هو محرك سير عمل **Directed Acyclic Graph (DAG)** على مستوى الإنتاج، يُمكّن وكيل LLM من تنظيم مهام متوازية معقدة في جلسة واحدة. القدرات الأساسية:

- **جدولة تلقائية**: توليد وكلاء فرعيين تلقائياً بناءً على تبعيات العقد، وتنفيذهم بالتوازي
- **إعادة تخطيط ديناميكية**: إمكانية إعادة تخطيط سير العمل أثناء التشغيل (إضافة/حذف/تعديل العقد، تعديل حد التوازي)
- **الامتثال للقواعد الصارمة**: آلة الحالة غير قابلة للتجاوز، الحالة النهائية غير قابلة للعكس، الأحداث تبث إجبارياً، الأولوية للاستمرارية
- **تكامل أوامر Slash**: `/dag-ctl` للتحكم في التشغيل، `/dag-worker` لتكوين سير العمل
- **التدقيق المستمر**: مخطط SQLite 6 جداول، جميع تغييرات الحالة قابلة للتتبع

للاطلاع على التصميم المعماري الكامل، راجع [وثائق Harness-DAG-Workflow](./docs/harness-dag.md)، ولدليل التطوير راجع [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **الترخيص**: هذه الوحدة (بما فيها [`packages/opencode/src/dag/`](./packages/opencode/src/dag/) و [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts) و [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) والقوالب والوثائق المرتبطة) مُرخّصة بموجب **GNU AGPL v3** — استخدام هذه الوحدة يتطلب فتح جميع التعديلات. انظر [NOTICE](./NOTICE) و [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 تنفيذ HOOKS API الموسع

يحتفظ هذا الفرع بنظام Hooks API الأصلي ويعززه بالكامل:

- **22 حدث تشغيل**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 أنواع تنفيذ**: `command` (shell) / `mcp` (أداة MCP) / `http` (REST) / `prompt` (LLM بجولة واحدة) / `agent` (LLM متعدد الجولات)
- **بروتوكول اتصال JSON عبر stdin/stdout**: انظر وثائق البروتوكول الكاملة في [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **تحسينات هذا الفرع**: تكامل ناقل أحداث سير عمل DAG (أحداث `workflow.*` / `node.*`) + اشتراك TUI + توجيه HTTP API

### 🛡️ مساحة عزل الترميز خفيفة الوزن

يوفر هذا الفرع بيئة تشغيل معزولة ثنائية المسار، مما يسمح للوكيل/المستخدم بتجربة الكود في صندوق رمل آمن دون تلويث المستودع الحقيقي:

| مستوى العزل | الآلية | الاستخدام |
|---------|------|------|
| **Sandbox** (خفيف) | دليل مؤقت + تشخيص LSP + سلسلة أدوات متعددة اللغات (Python/Node/TS/Go/Rust/C/C++) | تشغيل تجريبي لملف واحد / تجارب صغيرة |
| **Worktree** (ثقيل) | فرع `git worktree` مستقل + عرض نظام ملفات مستقل | تحرير متوازي بواسطة عدة وكلاء، وإعادة هيكلة واسعة النطاق |

- 📦 **أداة Sandbox**: `packages/opencode/src/tool/sandbox.ts`، كل sandbox لديه ذاكرة تخزين مؤقتة مستقلة للاعتماديات (venv / node_modules)، يدعم وضع `ephemeral` للاستخدام لمرة واحدة ووضع `background` للمهام الطويلة غير المتزامنة
- 🌳 **مدير DAG Worktree**: في سير عمل DAG، يمكن تخصيص كل عقدة متوازية تلقائياً إلى فرع worktree مستقل، وبعد اكتمال العقدة يتم دمجها عبر `git merge` إلى الفرع الرئيسي

### 🔧 تصحيح أخطاء الميزات الصينية (مشاكل أصلية تم إصلاحها)

تم تصحيح وتحسين عدة مشكلات توافق/تجربة مستخدم في النسخة الأصلية عند استخدام الصينية، وتشمل:

- **تجزئة النص الصيني وحساب tokens**: معالجة استثنائية لأحرف CJK في بعض أدوات التجزئة
- **توافق علامات الترقيم بعرض كامل**: التسامح مع النقطتان وعلامات الاقتباس والأقواس بعرض كامل أثناء تحليل الإعدادات
- **معالجة المسارات الصينية**: تمرير صحيح لمسارات الملفات التي تحتوي على مسافات وأحرف CJK في hook/sandbox
- **توافق أسلوب الإدخال الصيني (IME)**: تأخير الإدخال واهتزاز المؤشر في TUI عند تفعيل نافذة مرشح IME

سجل الإصلاحات واختبارات الانحدار متاح في [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 إذا واجهت مشكلات أخرى متعلقة بالميزات الصينية أثناء الاستخدام، يُرجى تقديم خطوات إعادة الإنتاج في [قسم المشكلات](./issues)، وسأواصل التصحيح.

### 🔬 تصحيحات صغيرة أخرى (إصلاحات أصلية مدمجة)

يحتفظ هذا الفرع بعدة إصلاحات لتجربة المستخدم من النسخة الأصلية، وقد تم التحقق منها باختبارات الانحدار:

| المشكلة | commit الإصلاح الأصلي | النطاق المتأثر |
|------|-----------------|----------|
| 📋 **تلف المحتوى عند النسخ واللصق** — المحتوى الذي يلصقه المستخدم في TUI يتم اقتطاعه أو فقدانه بشكل خاطئ | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | تجربة إدخال TUI |
| 📐 **عدم تحديث التخطيط بعد اللصق** — بعد لصق نص طويل لا يتمدد ارتفاع صندوق prompt تلقائياً، مما يسبب اقتطاعاً بصرياً | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | تجربة إدخال TUI |
| 📎 **عدم وجود آلية احتياط عند فشل كتابة الحافظة** — عند فشل API `navigator.clipboard` (مثل بيئات HTTP)، تفشل عملية النسخ مباشرة | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | توافق المتصفحات |
| 🎨 **ضعف تباين لون شارة اللصق** — يصعب قراءة نص شارة ملخص اللصق في بعض السمات | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | تجربة بصرية TUI |
| 📏 **تقدير عرض أحرف CJK / شرق آسيا** — عرض الرموز التعبيرية والأحرف بعرض كامل والصينية وغيرها من أحرف العرض الشرقي لا يتطابق مع المساحة المشغولة، مما يسبب إزاحة المؤشر | تم تضمينه في نظام تصحيح تجزئة CJK | محاذاة الأحرف في TUI |
| ⌨️ **اهتزاز نافذة مرشح IME** — عند تفعيل أسلوب الإدخال الصيني/الياباني، يحدث اهتزاز المؤشر + تأخير إدخال الأحرف | رقعة workaround محلية | تجربة إدخال TUI |

> هذا الفرع لا يعيد اختراع العجلة: الإصلاحات التي قام بها الفرع الأصلي ستُدمج مع تحديثات فرع `stable` بشكل متزامن؛ يركز هذا الفرع بشكل أساسي على تصحيح المشكلات المتعلقة بالميزات الصينية / سير عمل DAG التي لم يعالجها الفرع الأصلي بعد.

## القدرات المحتفظ بها من المصدر الأصلي

القدرات التالية مستقاة بالكامل من opencode الأصلي (رخصة MIT)، ولم يُجرَ عليها أي تعديل وظيفي في هذا الفرع:

### تطبيق سطح المكتب (تجريبي)

يوفر OpenCode أيضاً تطبيق سطح مكتب. يمكن تنزيله مباشرة من [صفحة الإصدارات](https://github.com/anomalyco/opencode/releases) أو [opencode.ai/download](https://opencode.ai/download).

| المنصة                  | ملف التنزيل                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb` أو `.rpm` أو AppImage            |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### الوكلاء

يحتوي OpenCode على وكيلين مدمجين، يمكن التبديل بينهما بسرعة باستخدام مفتاح `Tab`:

- **build** - الوضع الافتراضي، بصلاحيات كاملة، مناسب لأعمال التطوير
- **plan** - وضع القراءة فقط، مناسب لتحليل واستكشاف الشيفرة
  - يرفض تعديل الملفات افتراضياً
  - يسأل قبل تشغيل أوامر bash
  - مفيد لاستكشاف قواعد الشيفرة غير المعروفة أو تخطيط التغييرات

كما يحتوي على وكيل فرعي **general** للمهام المعقدة والمتعددة الخطوات، للاستخدام الداخلي، ويمكن استدعاؤه بكتابة `@general` في الرسائل.

لمعرفة المزيد عن [الوكلاء](https://opencode.ai/docs/agents).

### تنفيذ مجموعة شاملة من ClaudeCode Hooks API

يحتفظ هذا الفرع بشكل كامل بنظام Hooks API الأصلي و 22 حدث تشغيل في وقت التشغيل. يتم تسجيل الـ Hooks في حقل `hooks` بملف الإعدادات حسب اسم الحدث، وتدعم خمسة أنواع تنفيذ: `command` و `mcp` و `http` و `prompt` و `agent`، وتتواصل عبر أظرف JSON عبر stdin/stdout. البروتوكول الكامل في [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

قائمة مفصلة بالأحداث وأنواع التنفيذ في [القسم المحفوظ من README الأصلي](./docs/readmes/upstream-features.md).

## الترخيص والإسناد

يستخدم هذا المستودع **نموذج ترخيص مختلط**:

| المحتوى | الترخيص | الموقع |
|------|------|------|
| شيفرة opencode الأصلية (معظم الملفات) | **MIT** | انظر [`LICENSE`](./LICENSE) |
| محرك سير العمل DAG المطور ذاتياً (`packages/opencode/src/dag/` والأدوات والقوالب والوثائق المرتبطة) | **GNU AGPL v3** | انظر [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

للاطلاع على وصف كامل للحدود، انظر ملف [`NOTICE`](./NOTICE).


### 🔒 بيان الترخيص الإجباري AGPL v3 (قيود صارمة في هذا الفرع)

**سياسة المؤلف للتطوير الثانوي لهذا المستودع:**

1. **يجب أن تخضع الشيفرة المطوَّرة ذاتيًا لـ GNU AGPL v3** — أي شيفرة تُضاف حديثًا أو يُعاد كتابتها أو تُعدَّل بشكل كبير بواسطة مؤلف هذا الفرع **يجب** أن تخضع لـ GNU Affero General Public License v3 أو إصدار أحدث (AGPL-3.0-or-later)
2. **شرط الانتشار لـ AGPL** — أي مشروع يستخدم أو يعدل أو يُشتق من وحدات AGPL-3.0 (مثل محرك سير عمل DAG) **يجب** أن يفتح مصدره الكامل بموجب AGPL-3.0 ويُتيح الوصول للمستخدمين النهائيين
3. **فتح المصدر الإجباري لـ SaaS** — إذا قمت بنشر هذا المشروع أو أعماله المشتقة كخدمة شبكية (SaaS / منصة سحابية)، **يجب عليك توفير رابط تنزيل الشيفرة الكاملة لجميع مستخدمي الخدمة** (وهذا هو البند الأساسي الذي يميز AGPL عن GPL، §13)
4. **الإبقاء على الإسناد** — يجب الاحتفاظ بإعلان المؤلف الأصلي، وعلامات حقوق النشر، ومعلومات الإسناد الواردة في ملف NOTICE

> ⚖️ **لماذا AGPL؟** يرى المؤلف أن قيمة البرمجيات مفتوحة المصدر تكمن في التعاون المستمر. يمنع AGPL “إغلاق المصدر لأغراض SaaS” الذي يضر بالمجتمع مفتوح المصدر — أي جهة تجارية تستفيد من هذا المشروع يجب أن تعود بالنفع على المجتمع.

**الأجزاء المرخصة بموجب MIT لا تخضع لهذه الشروط**، وتخضع فقط لتحكم فريق opencode الأصلي.

### العلاقة مع فريق opencode الأصلي

- ✅ هذا المشروع **مبني على** الشيفرة المصدرية لـ [opencode](https://github.com/sst/opencode)
- ❌ لا يوجد أي علاقة انتماء أو ترخيص بين هذا المشروع والفريق الرسمي لـ opencode (sst / anomalyco)
- ❌ هذا المشروع ليس إصدارًا رسميًا من opencode، ولا يقدم أي التزام بدعم المصدر الأصلي
- ❌ **لا يقدم فريق OpenCode الرسمي أي دعم فني أو ضمان أو تأييد لهذا الفرع** (وفقًا لمتطلبات الإسناد الواضحة في README الأصلي)
- ✅ محرك سير عمل DAG، وتصحيح الأخطاء (DEBUG) للميزات الصينية، والتحسينات الأخرى في هذا المشروع يتم صيانتها بشكل مستقل من قبل المؤلف
- ✅ تم الاحتفاظ بإسناد الشيفرة الأصلية ذات ترخيص MIT بالكامل، ولم يتم التلاعب بإعلانات المؤلف وحقوق النشر

إذا كنت ترغب في استخدام الإصدار الرسمي لـ opencode، يرجى زيارة https://opencode.ai أو https://github.com/sst/opencode.

## فهرس الوثائق

- [`docs/harness-dag.md`](./docs/harness-dag.md) — الوثائق الكاملة لـ Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — قائمة إصلاحات دعم اللغة الصينية
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — وصف القدرات المحتفظ بها من opencode الأصلي
- [`NOTICE`](./NOTICE) — حدود الترخيص وبيان الإسناد
- [`AGENTS.md`](./AGENTS.md) — دليل التطوير والإسهام

## المساهمة

إذا كنت مهتماً بالمساهمة بالشيفرة، يرجى قراءة [`CONTRIBUTING.md`](./CONTRIBUTING.md) قبل تقديم طلب سحب (PR).

### التطوير بناءً على هذا الفرع

إذا استخدمت "opencode" في اسم مشروعك (مثل "opencode-dashboard" أو "opencode-mobile")، يرجى الإشارة في README إلى أن هذا المشروع ليس تطويراً رسمياً من فريق OpenCode وليس له علاقة بمؤلف هذا الفرع.

## الأسئلة الشائعة (FAQ)

### ما الفرق بين هذا وClaude Code؟

متشابهان وظيفياً، والاختلافات الرئيسية:

- مفتوح المصدر بنسبة 100%
- غير مرتبط بمزود معين. يُنصح باستخدام نماذج [OpenCode Zen](https://opencode.ai/zen)، ولكن يمكن استخدام Claude أو OpenAI أو Google أو حتى النماذج المحلية
- دعم مدمج لـ LSP
- تركيز على واجهة الطرفية (TUI)
- معمارية عميل/خادم. يمكن تشغيله محلياً والتحكم به عن بُعد باستخدام جهاز محمول
- **🪝 مجموعة Hooks API فائقة**: بناءً على 22 حدث تشغيل × 5 أنواع تنفيذ في Claude Code، هذا الفرع **متوافق بالكامل مع بروتوكول Claude Code Hooks** ويضيف تكامل ناقل أحداث DAG workflow (`workflow.*` / `node.*`)، واشتراكات TUI، وتمريراً عبر HTTP API. المواصفة الكاملة: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 نظام تعليمات Goal**: أداة `todowrite` مع تتبع أهداف منظم يحافظان على قائمة عمل agent أثناء الجلسات الطويلة متعددة الخطوات ويمنعان فقدان حالة المهام عند تغيّر نافذة السياق
- **🪝 TODO PreHook**: يدعم حقن قائمة TODO في السياق عبر hooks من نوع `PreToolUse`؛ آلية العودة إلى الأهداف المدفوعة بالـ hooks تضمن أن agent يرى دائماً التقدم الحالي
- **🛡️ Sandbox Coding Workspace**: كل sandbox يملك مجلداً مؤقتاً مستقلاً وتشخيصات LSP وسلاسل أدوات متعددة اللغات (Python/Node/TS/Go/Rust/C/C++)؛ يستطيع agent تجربة الكود وتجميعه وتصحيح أخطائه في عزل، ثم دمجه في ملفات المشروع عبر edit/write بعد التحقق

### ما الفرق بين هذا والإصدار الرسمي من opencode؟

- **🪝 مجموعة Hooks API فائقة + تعليمات Goal + TODO PreHook + Sandbox Workspace**: تحتفظ بكل قدرات Hooks في upstream وتضيف تكامل أحداث DAG، وتتبع مهام منظم، وعودة إلى الأهداف مدفوعة بالـ hooks، وcoding sandbox معزول متعدد اللغات
- **🧩 وضع DAG WorkFlow (قيد التطوير · حوالي 90%)**: محرك [Harness-DAG-Workflow](./docs/harness-dag.md) مطوّر ذاتياً يسمح لـ LLM agent بتنسيق مهام متوازية متعددة العقد داخل جلسة واحدة. القدرات الأساسية اكتملت (الجدولة / دورة الحياة / pause-resume-cancel-replan-step / sub-DAG / التفرع الشرطي / data flow / crash recovery / probes)، ولوحة TUI متصلة، وما تبقى هو اللمسات النهائية
- **🔧 إصلاحات توافق اللغة الصينية**: DEBUG مستمر لـ CJK tokenization، وعلامات الترقيم كاملة العرض، والمسارات الصينية، وحالات IME الموروثة من upstream
- صيانة مستقلة طويلة الأمد، غير مرتبطة بجدول المصدر الأصلي

## المجتمع

- 📖 [مجتمع opencode الأصلي](https://opencode.ai)
- 📝 [قسم المشكلات في هذا الفرع](./issues) (للإبلاغ عن المشكلات واقتراح ميزات جديدة)
