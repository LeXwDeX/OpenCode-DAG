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
  <a href="./README.vi.md"><b>Tiếng Việt</b></a> ·
  <a href="./README.gr.md">Ελληνικά</a> ·
  <a href="./README.bn.md">বাংলা</a>
</p>

# OpenCode-DAG

> **Một bản fork được nâng cấp của [opencode](https://github.com/anomalyco/opencode) với bộ máy workflow DAG cấp production phục vụ điều phối multi-agent.**

Được xây dựng dựa trên terminal AI agent [opencode](https://github.com/anomalyco/opencode) có giấy phép MIT. **Không liên kết hay được xác nhận bởi đội ngũ OpenCode.**

---

## Trạng thái nhánh

| Nhánh | Nền tảng | Nội dung | Trạng thái |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + tối ưu Tools | ✅ **Ổn định** |
| **`dag-branch`** | main + DAG | Bộ máy workflow DAG (114 tệp) | 🔧 **Đang phát triển** — đang thích nghi với API của v1.17.11 |

> [!IMPORTANT]
> **Bộ máy workflow DAG đang được port** từ v1.15.10 sang codebase v1.17.11.
> Nó nằm trên nhánh `dag-branch` và **chưa hoạt động được**. Nhánh `main` dùng được đầy đủ
> với Hooks, vòng lặp tự động Goal và phơi bày ngoại lệ Tools — tất cả đều sẵn sàng cho production.

---

## Điều làm nên sự khác biệt của fork này

### 📌 Ổn định trên `main`

#### Hooks API (26 sự kiện × 5 loại thực thi)

Tương thích đầy đủ với giao thức Hooks của Claude Code: các loại hook `command`, `mcp`, `http`, `prompt`, `agent` với 26 hook events bao gồm `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` và hơn thế nữa. Hooks được nạp từ chuỗi `hooks.json` global / project / worktree, hoặc có thể đăng ký theo từng phiên khi chạy thông qua HTTP API; cơ chế gating workspace-trust tùy chọn (`requireTrust` + lệnh `/trust`) giới hạn thực thi hook chỉ trong các thư mục bạn đã phê duyệt.

Xem [tham chiếu hooks](./packages/core/src/plugin/skill/configure-hooks.md).

#### Vòng lặp tự động Goal

Một vòng lặp agent tự trị liên tục thúc đẩy agent hướng tới mục tiêu do người dùng định nghĩa. Một LLM judge quyết định sau mỗi lượt xem mục tiêu đã đạt được hay cần thêm lượt, trong phạm vi ngân sách lượt có thể cấu hình. Dùng `/goal <target>` để đặt, `/subgoal` để thêm mục tiêu con, `/goal resume` để tiếp tục mục tiêu đang tạm dừng.

#### Phơi bày ngoại lệ Tools

- **Sửa chữa JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — sửa các escape Unicode nhiều byte bị hỏng trong JSON do LLM tạo ra
- **Xác thực Question tool**: định dạng lỗi có cấu trúc với gợi ý ở cấp trường và ví dụ về lệnh gọi đúng
- **Mô tả Tools**: tài liệu `.txt` mở rộng cho `question`, `task`, `skill`, `webfetch`, `websearch` kèm các phần Parameters + Returns
- **Sửa shell pipe**: `stdout/stderr: "pipe"` trên mọi lệnh gọi `ChildProcess.make` + grace drain của reader fiber

### 🔧 Đang phát triển trên `dag-branch`

#### Bộ máy workflow DAG (AGPL-3.0)

Một **bộ máy workflow đồ thị có hướng không chu trình (DAG)** cho phép các LLM agent điều phối các tác vụ multi-node song song phức tạp trong một phiên duy nhất.

> ⚠️ **Trạng thái**: Sao chép thô từ fork v1.15.10 (114 tệp). 217 lỗi kiểu (type errors) đang chờ thích nghi API (đồng bộ `Database.use` → `Database.Service` dựa trên Effect, `Bus` → `EventV2Bridge`, v.v.). Chưa biên dịch được.

| Khả năng | Mô tả |
|---|---|
| **Lập lịch tự động** | Sinh child agent theo thứ tự dependency, song song khi có thể |
| **Lập kế hoạch lại động** | Thêm/xóa/cập nhật node và điều chỉnh concurrency giữa chừng khi chạy |
| **Toàn vẹn state machine** | Bốn luật sắt: cấm bypass state machine, trạng thái terminal không thể đảo ngược, event phải broadcast, persist trước khi mutate |
| **Terminal TUI** | Bảng điều khiển DAG đầy đủ với sơ đồ topology bằng block-char, tree view, hộp thoại node, cập nhật theo thời gian thực |
| **Phục hồi sau crash** | Phát hiện và tiếp tục các workflow đang chạy mồ côi khi khởi động lại |
| **Rẽ nhánh có điều kiện** | Node có thể thực thi hoặc bỏ qua có điều kiện dựa trên đầu ra ở thượng nguồn |
| **Lồng Sub-DAG** | Worker type `dag` sinh sub-workflow đệ quy (max depth 3) |
| **Kiểm toán bền vững** | Lược đồ SQLite 6-table, mọi chuyển trạng thái đều có thể truy vết |

### Các sửa lỗi CJK & localization

Sửa chữa toàn diện cho việc xử lý văn bản Trung/Nhật/Hàn: tokenization, dấu câu full-width, đường dẫn tệp, nhập liệu IME trong terminal UI. Xem [danh sách sửa lỗi](./docs/localization/zh-hans-fixes.md).

### Cách ly kép: Sandbox + Worktree

- **Sandbox** — các thư mục tạm thời phù du với chẩn đoán LSP cho thử nghiệm mã an toàn
- **Worktree** — cách ly `git worktree` cho từng workflow để chỉnh sửa multi-agent song song

---

## Cài đặt

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Gỡ các phiên bản cũ hơn 0.1.x trước khi cài đặt.

---

## Giữ nguyên upstream — và thêm nữa

Tất cả các khả năng của upstream có giấy phép MIT được bảo toàn đầy đủ:

- **Ứng dụng Desktop** (macOS / Windows / Linux) — tải về từ [releases](https://github.com/anomalyco/opencode/releases)
- **Agent Build & Plan** — dùng `Tab` để chuyển giữa chế độ truy cập đầy đủ và chỉ đọc
- **Đa nhà cung cấp** — Claude, OpenAI, Google, các mô hình local qua [OpenCode Zen](https://opencode.ai/zen)
- **LSP tích hợp sẵn** — chẩn đoán theo thời gian thực từ các language server
- **Kiến trúc client/server** — chạy nội bộ, điều khiển từ xa qua điện thoại

Fork này thêm bộ máy DAG, sửa lỗi CJK, workspace coding sandbox và theo dõi mục tiêu lên trên — mà không làm hỏng gì.

---

## Giấy phép

Kho lưu trữ này sử dụng **mô hình giấy phép hỗn hợp**:

| Nội dung | Giấy phép | Vị trí |
|---------|---------|----------|
| Mã opencode upstream (phần lớn) | **MIT** | [`LICENSE`](./LICENSE) |
| Bộ máy workflow DAG tự phát triển | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Chi tiết ranh giới đầy đủ trong [`NOTICE`](./NOTICE).

> ⚖️ **Tại sao AGPL?** Bộ máy DAG là tác phẩm khác biệt cốt lõi. AGPL đảm bảo bất kỳ bản phái sinh nào — kể cả triển khai SaaS — đều phải đóng góp lại.

---

## Tài liệu

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Kiến trúc & cách dùng bộ máy DAG
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Danh mục sửa lỗi CJK
- [`NOTICE`](./NOTICE) — Ranh giới giấy phép & ghi nhận nguồn
- [`AGENTS.md`](./AGENTS.md) — Hướng dẫn đóng góp & phát triển

## Cộng đồng

- 📖 [Cộng đồng opencode upstream](https://opencode.ai)
- 📝 [Theo dõi vấn đề của fork](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
