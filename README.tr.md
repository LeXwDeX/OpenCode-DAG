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
  <a href="./README.tr.md"><b>Türkçe</b></a> ·
  <a href="./README.uk.md">Українська</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.gr.md">Ελληνικά</a> ·
  <a href="./README.bn.md">বাংলা</a>
</p>

# OpenCode-DAG

> **Çoklu ajan orkestrasyonu için production-grade DAG iş akışı motoruna sahip, geliştirilmiş bir [opencode](https://github.com/anomalyco/opencode) fork'u.**

MIT lisanslı [opencode](https://github.com/anomalyco/opencode) terminal AI ajanının üzerine inşa edilmiştir. **OpenCode ekibiyle bağlantılı değildir ve onlar tarafından onaylanmamıştır.**

---

## Dal Durumu

| Dal | Taban | İçerik | Durum |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + Tools optimizasyonu | ✅ **Kararlı** |
| **`dag-branch`** | main + DAG | DAG iş akışı motoru (114 dosya) | 🔧 **Geliştiriliyor** — v1.17.11 API'lerine uyumlandırılıyor |

> [!IMPORTANT]
> **DAG iş akışı motoru şu anda** v1.15.10'dan v1.17.11 kod tabanına **taşınmaktadır**.
> `dag-branch` dalında yer alır ve **henüz çalışır durumda değildir**. `main` dalı Hooks, Goal
> otomatik döngüsü ve Tools istisnalarının gösterimi ile tamamen kullanılabilir — hepsi production-ready.

---

## Bu fork'u farklı kılan

### 📌 main üzerinde Kararlı

#### Hooks API (26 olay × 5 yürütme tipi)

Tam Claude Code hooks protokol uyumluluğu: `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` ve daha fazlasını içeren 26 hook olayı ile birlikte `command`, `mcp`, `http`, `prompt`, `agent` hook tipleri. Hook'lar global / proje / worktree `hooks.json` zincirinden yüklenir ya da HTTP API üzerinden çalışma zamanında oturum başına kaydedilebilir; opsiyonel workspace-trust geçidi (`requireTrust` + `/trust` komutu) hook yürütmesini onayladığınız dizinlerle sınırlar.

[Hooks referansına](./packages/core/src/plugin/skill/configure-hooks.md) bakın.

#### Goal Otomatik Döngü

Bir ajanı kullanıcı tanımlı hedefe doğru sürekli yönlendiren otonom bir ajan döngüsü. Bir LLM jüri, her turdan sonra hedefe ulaşıldığını mı yoksa daha fazla tur gerekip gerekmediğini, yapılandırılabilir bir tur bütçesi içinde karar verir. `/goal <target>` ile ayarla, `/subgoal` ile alt-hedefler ekle, `/goal resume` ile duraklatılmış hedefe devam et.

#### Tools İstisna Gösterimi

- **JSON onarımı**: `safeParseJson` + `fixJsonUnicodeEscapes` — LLM tarafından üretilen JSON'daki bozuk multi-byte Unicode escape'lerini onarır
- **Question aracı doğrulaması**: alan düzeyinde ipuçları ve doğru-çağrı örnekleri ile yapılandırılmış hata biçimlendirmesi
- **Araç açıklamaları**: `question`, `task`, `skill`, `webfetch`, `websearch` için Parameters + Returns bölümleriyle genişletilmiş `.txt` dokümanları
- **Shell pipe düzeltmesi**: tüm `ChildProcess.make` çağrılarında `stdout/stderr: "pipe"` + reader fiber grace drain

### 🔧 dag-branch üzerinde Geliştiriliyor

#### DAG İş Akışı Motoru (AGPL-3.0)

LLM ajanlarının tek bir oturum içinde karmaşık multi-node paralel görevleri orkestre etmesini sağlayan bir **yönlü döngüsüz graf (DAG) iş akışı motoru**.

> ⚠️ **Durum**: v1.15.10 fork'undan ham olarak kopyalandı (114 dosya). 217 tip hatası API adaptasyonunu bekliyor (senkron `Database.use` → Effect tabanlı `Database.Service`, `Bus` → `EventV2Bridge` vb.). Henüz derlenemiyor.

| Yetenek | Açıklama |
|---|---|
| **Otomatik zamanlama** | Bağımlılık sırasına göre child ajanlar oluşturur, mümkün olduğunca paralel |
| **Dinamik yeniden planlama** | Çalışma sırasında düğüm ekleme/kaldırma/güncelleme ve eşzamanlılığı ayarlama |
| **State machine bütünlüğü** | Dört demir kural: state machine atlanması yasak, terminal durumlar geri alınamaz, olaylar yayınlanmalı, mutasyondan önce persist |
| **Terminal TUI** | Block-char topoloji haritalı, ağaç görünümü, düğüm diyalogları, gerçek zamanlı güncellemelerle tam DAG kontrol paneli |
| **Çökme kurtarma** | Yeniden başlatmada yetim kalmış çalışan iş akışlarını algılar ve sürdürür |
| **Koşullu dallanma** | Düğümler upstream çıktısına göre koşullu olarak yürütülebilir veya atlanabilir |
| **Sub-DAG iç içe** | `dag` worker tipi özyinelemeli sub-workflow'lar oluşturur (maks. derinlik 3) |
| **Kalıcı denetim** | 6-tablo SQLite şeması, tüm durum geçişleri izlenebilir |

### CJK ve yerelleştirme düzeltmeleri

Çince/Japonca/Korece metin işleme için kapsamlı düzeltmeler: tokenization, tam-geniş noktalama, dosya yolları, terminal UI'sinde IME girişi. [Düzeltmeler listesine](./docs/localization/zh-hans-fixes.md) bakın.

### İkili izolasyon: Sandbox + Worktree

- **Sandbox** — güvenli kod deneyleri için LSP tanılamalı geçici temp dizinler
- **Worktree** — paralel multi-agent düzenleme için iş akışı başına `git worktree` izolasyonu

---

## Kurulum

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Kurulumdan önce 0.1.x'ten eski sürümleri kaldırın.

---

## Upstream'i koru — ve daha fazlası

Tüm upstream MIT lisanslı yetenekler tamamen korunmuştur:

- **Masaüstü uygulaması** (macOS / Windows / Linux) — [releases](https://github.com/anomalyco/opencode/releases)'ten indirin
- **Build & Plan ajanları** — tam erişim ve salt-okunur modlar arasında geçiş için `Tab`
- **Multi-provider** — Claude, OpenAI, Google, yerel modlar [OpenCode Zen](https://opencode.ai/zen) üzerinden
- **Yerleşik LSP** — dil sunucularından gerçek zamanlı tanılama
- **İstemci/sunucu mimarisi** — yerel olarak çalıştırın, mobilden uzaktan yönetin

Bu fork DAG motorunu, CJK düzeltmelerini, sandbox kodlama workspace'ini ve hedef takibini ekler — hiçbir şey bozmadan.

---

## Lisans

Bu depo **karışık bir lisans modeli** kullanır:

| İçerik | Lisans | Konum |
|---------|---------|----------|
| Upstream opencode kodu (büyük çoğunluk) | **MIT** | [`LICENSE`](./LICENSE) |
| Kendi geliştirilen DAG iş akışı motoru | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Sınırların tam detayları [`NOTICE`](./NOTICE) içinde.

> ⚖️ **Neden AGPL?** DAG motoru temel farklılaştırıcı iştir. AGPL, SaaS dağıtımları dahil herhangi bir türevin geri katkıda bulunmasını sağlar.

---

## Dokümanlar

- [`docs/harness-dag.md`](./docs/harness-dag.md) — DAG motoru mimarisi ve kullanımı
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — CJK düzeltmeleri kataloğu
- [`NOTICE`](./NOTICE) — lisans sınırları ve atıf
- [`AGENTS.md`](./AGENTS.md) — katkı ve geliştirme rehberi

## Topluluk

- 📖 [Upstream opencode topluluğu](https://opencode.ai)
- 📝 [Fork sorun takibi](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
