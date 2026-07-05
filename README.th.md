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
  <a href="./README.th.md"><b>ไทย</b></a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.uk.md">Українська</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.gr.md">Ελληνικά</a> ·
  <a href="./README.bn.md">বাংলা</a>
</p>

# OpenCode-DAG

> **เป็น fork ที่ปรับปรุงแล้วของ [opencode](https://github.com/anomalyco/opencode) พร้อมด้วยอิงจิ้นเวิร์กโฟลว์ DAG ระดับ production สำหรับการประสานงาน multi-agent**

สร้างบนพื้นฐานของ [opencode](https://github.com/anomalyco/opencode) terminal AI agent ที่อยู่ภายใต้สัญญาอนุญาต MIT **ไม่ได้เกี่ยวข้องหรือได้รับการรับรองจากทีม OpenCode**

---

## สถานะ Branch

| Branch | Base | เนื้อหา | สถานะ |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + การปรับปรุง Tools | ✅ **เสถียร** |
| **`dag-branch`** | main + DAG | DAG workflow engine (114 files) | 🔧 **อยู่ระหว่างพัฒนา** — กำลังปรับให้เข้ากับ API ของ v1.17.11 |

> [!IMPORTANT]
> **กำลังย้าย DAG workflow engine อยู่ในขณะนี้** จาก v1.15.10 มายัง codebase ของ v1.17.11
> โค้ดส่วนนี้อยู่บน `dag-branch` และ **ยังใช้งานไม่ได้** ส่วน branch `main` นั้นใช้งานได้เต็มรูปแบบ
> พร้อม Hooks, Goal auto-loop และการเปิดเผย exception ของ Tools — ทั้งหมดพร้อมใช้งานระดับ production แล้ว

---

## สิ่งที่ทำให้ fork นี้แตกต่าง

### 📌 เสถียรบน `main`

#### Hooks API (26 events × 5 execution types)

เข้ากันได้อย่างสมบูรณ์กับโปรโตคอล Hooks ของ Claude Code: ประเภท hook แบบ `command`, `mcp`, `http`, `prompt`, `agent` พร้อม hook events 26 รายการ รวมถึง `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` และอื่น ๆ Hooks โหลดจากลูกโซ่ `hooks.json` ระดับ global / project / worktree หรือลงทะเบียนแบบ per-session ขณะรันผ่าน HTTP API ได้ ส่วนการคุม workspace-trust แบบ optional (`requireTrust` + คำสั่ง `/trust`) จะจำกัดการรัน hook ไว้เฉพาะ directory ที่คุณอนุมัติเท่านั้น

ดูเพิ่มเติมได้ที่ [hooks reference](./packages/core/src/plugin/skill/configure-hooks.md)

#### Goal Auto-Loop

วงรอบ agent อัตโนมัติที่ขับเคลื่อน agent ให้ก้าวไปยังเป้าหมายที่ผู้ใช้กำหนดอย่างต่อเนื่อง โดย LLM judge จะตัดสินใจหลังแต่ละรอบว่าบรรลุเป้าหมายแล้วหรือยังต้องการรอบเพิ่ม ภายในงบประมาณรอบที่ปรับตั้งได้ ใช้ `/goal <target>` เพื่อตั้ง, `/subgoal` เพื่อเพิ่ม sub-goal, และ `/goal resume` เพื่อทำต่อจากเป้าหมายที่หยุดไว้

#### Tools Exception Exposure

- **ซ่อมแซม JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — ซ่อมแซม Unicode escape แบบหลายไบต์ที่เสียใน JSON ที่ LLM สร้างขึ้น
- **การตรวจสอบของ Question tool**: การจัดรูปแบบ error แบบมีโครงสร้าง พร้อม hint ระดับ field และตัวอย่างการเรียกที่ถูกต้อง
- **คำอธิบาย Tools**: เอกสาร `.txt` แบบขยายสำหรับ `question`, `task`, `skill`, `webfetch`, `websearch` พร้อมส่วน Parameters + Returns
- **แก้ shell pipe**: กำหนด `stdout/stderr: "pipe"` บนการเรียก `ChildProcess.make` ทุกครั้ง + reader fiber grace drain

### 🔧 อยู่ระหว่างพัฒนาบน `dag-branch`

#### DAG Workflow Engine (AGPL-3.0)

**อิงจิ้นเวิร์กโฟลว์กราฟอะคลิกแบบมีทิศทาง (DAG)** ที่ให้ LLM agents ประสานงาน multi-node parallel tasks ที่ซับซ้อนภายใน session เดียว

> ⚠️ **สถานะ**: คัดลอกดิบ ๆ มาจาก fork v1.15.10 (114 files) ยังมี type errors 217 รายการรอการปรับ API (ซิงค์ `Database.use` → `Database.Service` แบบ Effect, `Bus` → `EventV2Bridge` ฯลฯ) ยังคอมไพล์ไม่ผ่าน

| ความสามารถ | คำอธิบาย |
|---|---|
| **Auto-scheduling** | spawn child agents ตามลำดับ dependency โดยทำ parallel ได้ที่ไหนก็ได้ |
| **การวางแผนใหม่แบบ dynamic** | เพิ่ม/ลบ/อัปเดต node และปรับ concurrency ระหว่างรันได้ |
| **ความถูกต้องของ state machine** | กฎเหล็กสี่ข้อ: ห้าม bypass state machine, terminal state เปลี่ยนกลับไม่ได้, event ต้อง broadcast, persist ก่อน mutate |
| **Terminal TUI** | แผงควบคุม DAG แบบเต็ม พร้อม block-char topology map, tree view, node dialogs และการอัปเดตแบบ real-time |
| **การกู้คืนจาก crash** | ตรวจจับและทำต่อ workflow ที่กำลังรันและถูกทิ้งไว้เมื่อ restart |
| **Conditional branching** | node สามารถทำงานหรือข้ามแบบมีเงื่อนไข โดยอิงจาก output ต้นน้ำ |
| **การซ้อน Sub-DAG** | worker type `dag` spawn sub-workflow แบบ recursive (max depth 3) |
| **การตรวจสอบแบบถาวร** | สคีมา SQLite แบบ 6-table การเปลี่ยน state ทั้งหมดสามารถสืบย้อนได้ |

### การแก้ไข CJK และ localization

การแก้ไขอย่างกว้างขวางสำหรับการจัดการข้อความภาษาจีน/ญี่ปุ่น/เกาหลี: tokenization, เครื่องหมายวรรคตอนแบบ full-width, file paths, การป้อนข้อมุลด้วย IME ใน terminal UI ดู [รายการแก้ไข](./docs/localization/zh-hans-fixes.md)

### การแยกแบบคู่: Sandbox + Worktree

- **Sandbox** — temp dir แบบชั่วคราว พร้อม LSP diagnostics สำหรับการทดลองโค้ดอย่างปลอดภัย
- **Worktree** — การแยก `git worktree` สำหรับแต่ละ workflow เพื่อการแก้ไขแบบ multi-agent parallel

---

## การติดตั้ง

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> ถอนการติดตั้งเวอร์ชันเก่ากว่า 0.1.x ก่อนติดตั้ง

---

## รักษา upstream ไว้ — และเพิ่มเติม

ความสามารถทั้งหมดของ upstream ที่อยู่ภายใต้สัญญา MIT ได้รับการเก็บรักษาไว้อย่างสมบูรณ์:

- **แอป Desktop** (macOS / Windows / Linux) — ดาวน์โหลดจาก [releases](https://github.com/anomalyco/opencode/releases)
- **Build & Plan agents** — ใช้ `Tab` สำหรับสลับระหว่างโหมดเข้าถึงแบบเต็มและแบบอ่านอย่างเดียว
- **รองรับหลาย provider** — Claude, OpenAI, Google, โมเดล local ผ่าน [OpenCode Zen](https://opencode.ai/zen)
- **LSP ในตัว** — diagnostics แบบ real-time จาก language servers
- **สถาปัตยกรรม client/server** — รันบนเครื่อง ควบคุมจากระยะไกลผ่านมือถือ

fork นี้เพิ่ม DAG engine, การแก้ไข CJK, เวิร์กสเปซ sandbox coding และการติดตามเป้าหมายเข้าไปด้วย — โดยไม่ทำลายอะไรเลย

---

## ลิขสิทธิ์

repository นี้ใช้ **โมเดลลิขสิทธิ์แบบผสม**:

| เนื้อหา | ลิขสิทธิ์ | ตำแหน่ง |
|---------|---------|----------|
| โค้ด opencode ต้นน้ำ (ส่วนใหญ่) | **MIT** | [`LICENSE`](./LICENSE) |
| DAG workflow engine ที่พัฒนาเอง | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

รายละเอียดขอบเขตทั้งหมดอยู่ใน [`NOTICE`](./NOTICE)

> ⚖️ **ทำไมใช้ AGPL?** DAG engine เป็นผลงานที่แตกต่างหลัก AGPL ช่วยให้มั่นใจว่างานที่มาจากสิ่งนี้ — รวมถึงการ deploy แบบ SaaS — จะต้องแสดงความขอบคุณโดยการส่งงานคืน

---

## เอกสาร

- [`docs/harness-dag.md`](./docs/harness-dag.md) — สถาปัตยกรรมและวิธีใช้ DAG engine
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — แคตตาล็อกการแก้ไข CJK
- [`NOTICE`](./NOTICE) — ขอบเขตลิขสิทธิ์และการระบุแหล่งที่มา
- [`AGENTS.md`](./AGENTS.md) — คู่มือการมีส่วนร่วมและการพัฒนา

## ชุมชน

- 📖 [ชุมชน opencode ต้นน้ำ](https://opencode.ai)
- 📝 [ตัวติดตามปัญหาของ fork](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
