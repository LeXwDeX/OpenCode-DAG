<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 the fork author (see NOTICE file for attribution).
Licensed under GNU AGPL v3; modifications must be open-sourced.
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
  <a href="./README_JA.md">日本語</a> ·
  <a href="./README_KO.md">한국어</a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md"><b>Türkçe</b></a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (Geliştirilmiş Sürüm)

> **⚠️ Beyan**: Bu proje, [opencode](https://github.com/sst/opencode) projesinin optimize edilmiş bir dalıdır ve bağımsız bir geliştirici tarafından orijinal sürümün üzerine inşa edilerek sürdürülmektedir. Bu proje **OpenCode resmi ekibiyle hiçbir ilişkisi yoktur** ve herhangi bir bağlılık taşımaz. Orijinal proje, opencode ekibi tarafından MIT lisansı altında yayımlanmıştır; bu dal, yukarı akış MIT lisansını korurken birkaç özgün geliştirilmiş modül eklemektedir (ayrıntılar için [NOTICE](./NOTICE) dosyasına bakınız).

## Tanıtım

Bu proje, opencode resmi sürümünün **yeniden düzenlenmiş ve geliştirilmiş versiyonudur**. Hedefleri şunlardır:

- 🔧 **Çince özellik sorunlarını düzeltmek**: Yukarı akışta bulunan Çince kelime bölme, CJK karakter işleme, tam genişlikli noktalama işaretleri, Çince dosya yolları ve Çince giriş yöntemi (IME) senaryolarındaki uyumluluk sorunlarını giderir (ayrıntılar için [Çince özellik düzeltmeleri listesi](./docs/localization/zh-hans-fixes.md) sayfasına bakınız)
- 🧩 **Üretim düzeyinde DAG iş akışı motoru sağlamak**: Özgün geliştirilmiş [Harness-DAG-Workflow](./docs/harness-dag.md), LLM agent'ın tek bir oturumda çok düğümlü paralel görevleri düzenleyip çalıştırmasını sağlar
- 🎯 **Yukarı akış uyumluluğunu korumak**: Yukarı akış MIT lisanslı kodun tamamı olduğu gibi bırakılır; mevcut yapı bozulmaz, yukarı akış API'si kirletilmez

## Kurulum

```bash
# Doğrudan kurulum (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Paket yöneticileri
npm i -g opencode-ai@latest        # bun/pnpm/yarn da kullanılabilir
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS ve Linux (önerilir, daima güncel)
brew install opencode              # macOS ve Linux (resmi brew formülü, daha düşük güncelleme sıklığı)
sudo pacman -S opencode            # Arch Linux (Kararlı)
paru -S opencode-bin               # Arch Linux (AUR'dan en son sürüm)
mise use -g opencode               # Herhangi bir sistem
nix run nixpkgs#opencode           # veya en son geliştirme dalı için github:anomalyco/opencode
```

> [!TIP]
> Kurulumdan önce 0.1.x öncesindeki eski sürümleri kaldırınız.

## Bu Dalın Özgün Özellikleri

Bu dal, üst akış opencode üzerine inşa edilmiştir ve aşağıdaki yetenekleri **yeni ekler** veya **önemli ölçüde geliştirir** (ayrıntılar için ilgili bölümlere bakın):

| Özellik | Kısa Açıklama | Lisans |
|------|------|------|
| 🧩 DAG HARNESS Düzenleme Görev Sistemi | LLM ajanının tek bir oturumda çok düğümlü paralel iş akışı düzenlemesini sağlar | AGPL-3.0 |
| 🪝 HOOKS API Üst Küme Gerçeklemesi | 22 çalışma zamanı olayı × 5 yürütme türü ile eksiksiz Hooks sistemi | MIT + bu dal geliştirmesi |
| 🛡️ Hafif CODING Yalıtım Alanı | Sandbox + Worktree çift yollu yalıtılmış yürütme ortamı | MIT + bu dal geliştirmesi |
| 🔧 Çince Özellik HATA GİDERME | CJK sözcük bölme / tam genişlikli noktalama / IME uyumluluğu / Çince yollar | MIT |
| 🔬 Diğer Küçük HATA GİDERMELER | Kopyala-yapıştır, Doğu Asya dili genişliği, Çince çıktı kesilmesi vb. | MIT |

### 🧩 DAG HARNESS Düzenleme Görev Sistemi (Özgün Modül · AGPL-3.0)

Eskiden Harness-DAG-Workflow olarak bilinirdi. Bir LLM ajanının tek bir oturumda karmaşık paralel görevleri düzenlemesine olanak tanıyan, üretim seviyesinde bir **Yönlü Döngüsüz Graf (DAG)** iş akışı motorudur. Temel yetenekler:

- **Otomatik Zamanlama**: Düğüm bağımlılıklarına göre alt ajanları otomatik olarak spawn eder, paralel çalıştırır
- **Dinamik Yeniden Planlama**: Çalışma sırasında iş akışını gerçek zamanlı olarak yeniden planlayabilir (düğüm ekleme/silme/değiştirme, eşzamanlılık üst sınırını ayarlama)
- **Katı Kural Uyumluluğu**: Durum makinesi atlanamaz, son durum geri alınamaz, olaylar yayınlanmak zorundadır, kalıcılık önceliklidir
- **Slash Komut Entegrasyonu**: Çalışmayı kontrol etmek için `/dag-ctl`, iş akışını yapılandırmak için `/dag-worker`
- **Kalıcı Denetim**: SQLite 6 tablo şeması, tüm durum değişiklikleri izlenebilir

Tam mimari tasarımı için [Harness-DAG-Workflow belgesine](./docs/harness-dag.md), geliştirme kılavuzu için [AGENTS.md](./packages/opencode/src/dag/AGENTS.md) dosyasına bakın.

> **Lisans**: Bu modül ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) ve ilgili şablonlar ile belgeler) **GNU AGPL v3** lisansı altında yayımlanmıştır——bu modülü kullanmak, tüm değişikliklerin açık kaynak olarak sunulmasını gerektirir. Ayrıntılar için [NOTICE](./NOTICE) ve [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE) dosyalarına bakın.

### 🪝 HOOKS API Üst Küme Gerçeklemesi

Bu dal, üst akışın Hooks API sistemini eksiksiz olarak korur ve geliştirir:

- **22 çalışma zamanı tetikleme olayı**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 yürütme türü**: `command` (shell) / `mcp` (MCP aracı) / `http` (REST) / `prompt` (tek turlu LLM) / `agent` (çok turlu LLM)
- **stdin/stdout JSON zarf iletişim protokolü**: Tam protokol belgesi için bkz. [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Bu dal geliştirmeleri**: DAG iş akışı olay veri yolu entegrasyonu (`workflow.*` / `node.*` olayları) + TUI aboneliği + HTTP API yönlendirme

### 🛡️ Hafif CODING Yalıtım Alanı

Bu dal, ajanın/kullanıcının gerçek depoyu kirletmeden güvenli bir korumalı alanda kod denemesi yapabilmesi için çift yollu yalıtılmış yürütme ortamı sunar:

| Yalıtım Seviyesi | Mekanizma | Kullanım Amacı |
|---------|------|------|
| **Sandbox** (hafif) | Geçici dizin + LSP tanılama + çoklu dil araç zinciri (Python/Node/TS/Go/Rust/C/C++) | Tek dosya / küçük deney kod denemeleri |
| **Worktree** (ağır) | `git worktree` bağımsız dal + bağımsız dosya sistemi görünümü | Çoklu ajan paralel düzenleme, büyük ölçekli yeniden yapılandırma |

- 📦 **Sandbox Aracı**: `packages/opencode/src/tool/sandbox.ts`, her sandbox'un bağımsız bağımlılık önbelleği (venv / node_modules) vardır; `ephemeral` tek seferlik mod ve `background` eşzamansız uzun görev desteği
- 🌳 **DAG Worktree Yöneticisi**: DAG iş akışında, her paralel düğüm otomatik olarak bağımsız bir worktree dalına atanabilir, düğüm tamamlandıktan sonra `git merge` ile ana hatta birleştirilir

### 🔧 Çince Özellik HATA GİDERME (Üst Kaynakta Düzeltilen Sorunlar)

Üst akış sürümünde Çince kullanım senaryolarında tespit edilen bazı uyumluluk/deneyim sorunları üzerinde HATA GİDERME ve optimizasyon yapılmıştır, kapsam:

- **Çince sözcük bölme ve token sayımı**: CJK karakterlerin belirli tokenizer'lardaki anormal işlenmesi
- **Tam genişlikli noktalama uyumluluğu**: Tam genişlikli iki nokta, tırnak işareti, parantezin yapılandırma ayrıştırmada toleranslı hale getirilmesi
- **Çince yol yönetimi**: Boşluk ve CJK karakterleri içeren dosya yollarının hook/sandbox içinde doğru şekilde iletilmesi
- **Çince Giriş Yöntemi (IME) uyumluluğu**: TUI üzerinde IME aday penceresi durumunda giriş gecikmesi ve imleç titremesi

Somut düzeltme kayıtları ve regresyon testleri için [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) dosyasına bakın.

> 💡 Kullanım sırasında başka Çince özellik sorunları fark ederseniz, lütfen [issue alanında](./issues) yeniden oluşturma adımlarını iletin, HATA GİDERMEYE devam edeceğim.

### 🔬 Diğer Küçük HATA GİDERMELER (Entegre Edilmiş Üst Kaynak Düzeltmeleri)

Bu dal, üst akıştaki bir dizi küçük deneyim sorunu düzeltmesini eksiksiz olarak korur ve regresyon testleriyle doğrulanmıştır:

| Sorun | Üst Kaynak Düzeltme Commit'i | Etkilenen Alan |
|------|-----------------|----------|
| 📋 **Kopyala-yapıştır içeriğinin bozulması** — Kullanıcının yapıştırdığı komut istemi içeriği TUI'de hatalı şekilde kesiliyor veya karakter kaybı yaşanıyor | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI giriş deneyimi |
| 📐 **Yapıştırma sonrası düzenin yenilenmemesi** — Uzun metin yapıştırıldıktan sonra komut istemi kutusunun yüksekliği otomatik olarak genişlemiyor, görsel kesilme oluşuyor | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI giriş deneyimi |
| 📎 **Pano yazma başarısızlığında geri dönüş yok** — `navigator.clipboard` API'si başarısız olduğunda (HTTP ortamı gibi), kopyalama işlemi doğrudan hata veriyor | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Tarayıcılar arası uyumluluk |
| 🎨 **Yapıştırma rozeti ön plan rengi kontrast yetersizliği** — Yapıştırma işlemi özet rozetinin metni bazı temalarda zor okunuyor | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI görsel deneyimi |
| 📏 **CJK / Doğu Asya karakter genişliği tahmini** — emoji, tam genişlikli karakter, hanzi gibi Doğu Asya genişliğindeki karakterlerin görüntü genişliği gerçek kaplama ile uyuşmuyor, imleç kaymasına yol açıyor | CJK sözcük bölme düzeltme sistemine dahil edildi | TUI karakter hizalama |
| ⌨️ **IME aday penceresi titremesi** — Çince / Japonca giriş yöntemi etkinleştirildiğinde imleç titremesi + karakter ekleme gecikmesi | Yerel geçici çözüm yaması | TUI giriş deneyimi |

> Bu dal, tekerleği yeniden icat etmez: üst akışta düzeltilmiş sorunlar, `stable` dalı ile birleştirme güncellemeleriyle senkronize edilir; bu dal esas olarak üst akışın henüz ele almadığı Çince özellik / DAG iş akışıyla ilgili sorunlara yönelik HATA GİDERME yapar.

## Yukarı Akıştan Korunan Yetenekler

Aşağıdaki yetenekler tamamen yukarı akış opencode'dan (MIT lisansı) gelmektedir; bu dal işlevsel değişiklik yapmamıştır:

### Masaüstü Uygulaması (BETA)

OpenCode ayrıca bir masaüstü uygulaması da sunmaktadır. Doğrudan [Yayımlar sayfası](https://github.com/anomalyco/opencode/releases) veya [opencode.ai/download](https://opencode.ai/download) adresinden indirilebilir.

| Platform              | İndirme Dosyası                           |
| --------------------- | ----------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg`     |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`         |
| Windows               | `opencode-desktop-windows-x64.exe`        |
| Linux                 | `.deb`, `.rpm` veya AppImage              |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agent'lar

OpenCode, `Tab` tuşuyla hızlıca geçiş yapılabilen iki yerleşik Agent içerir:

- **build** - Varsayılan mod, tam yetkiye sahiptir, geliştirme çalışmaları için uygundur
- **plan** - Salt okunur mod, kod analizi ve keşif için uygundur
  - Varsayılan olarak dosya değişikliklerini reddeder
  - Bash komutlarını çalıştırmadan önce sorar
  - Bilinmeyen kod tabanlarını keşfetmek veya değişiklikleri planlamak için idealdir

Ayrıca karmaşık aramalar ve çok adımlı görevler için **general** adlı bir alt Agent da dahildir; dahili olarak kullanılır ve mesajlara `@general` yazılarak da çağrılabilir.

[Agent'lar](https://opencode.ai/docs/agents) hakkında daha fazla bilgi edinin.

### ClaudeCode Hooks API Üst Küme Uygulaması

Bu dal, yukarı akışın Hooks API ekosistemini ve 22 çalışma zamanı tetikleme olayını eksiksiz korur. Hook'lar, yapılandırma dosyasının `hooks` alanında olay adına göre kaydedilir ve `command`, `mcp`, `http`, `prompt`, `agent` olmak üzere beş yürütme türünü destekler; stdin/stdout JSON zarfı üzerinden iletişim kurar. Tam protokol için [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md) dosyasına bakınız.

Ayrıntılı olay listesi ve yürütme türü tablosu için [Yukarı akış özellikleri korunmuş bölümü](./docs/readmes/upstream-features.md) sayfasına bakınız.

## Lisans ve Atıf

Bu depo **karma lisans modeli** kullanmaktadır:

| İçerik | Lisans | Konum |
|--------|--------|-------|
| Yukarı akış opencode kodu (dosyaların büyük çoğunluğu) | **MIT** | [`LICENSE`](./LICENSE) dosyasına bakınız |
| Özgün DAG iş akışı motoru (`packages/opencode/src/dag/` ve ilgili araçlar, şablonlar, belgeler) | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) dosyasına bakınız |

Tam sınır açıklaması için [`NOTICE`](./NOTICE) dosyasına bakınız.

### 🔒 AGPL v3 Zorunlu Lisans Bildirimi (Bu Dal İçin Kesin Kısıtlama)

**Bu projenin yazarının bu depo için ikincil geliştirme politikası:**

1. **Kendi geliştirdiği kod GNU AGPL v3 kullanmalıdır** — Bu dalın yazarı tarafından yeni eklenen, yeniden yazılan veya önemli ölçüde değiştirilen herhangi bir kod **zorunlu olarak** GNU Affero Genel Kamu Lisansı v3 veya daha üstü (AGPL-3.0-or-later) kullanmalıdır.
2. **AGPL'nin bulaşıcılık gerekliliği** — AGPL-3.0 modüllerini (DAG iş akışı motoru vb.) kullanan, değiştiren veya türeten herhangi bir proje, **tam kaynak kodunu AGPL-3.0 ile açık kaynak yapmak zorundadır** ve son kullanıcılara erişim sağlamalıdır.
3. **SaaS zorunlu açık kaynak** — Bu projeyi veya türetilmiş çalışmalarını bir ağ hizmeti (SaaS / bulut platformu) olarak dağıtırsanız, **hizmeti kullanan tüm kullanıcılara tam kaynak kodu indirme bağlantısı sağlamak zorundasınız** (Bu, AGPL'yi GPL'den ayıran temel maddedir, §13).
4. **Atıfın korunması** — Orijinal yazar beyanı, telif hakkı bildirimi ve BİLDİRİM (NOTICE) dosyasındaki aitlik bilgileri korunmalıdır.

> ⚖️ **Neden AGPL?** Yazar, açık kaynak yazılımın değerinin sürekli işbirliğinde yattığına inanmaktadır. AGPL, "kapalı kaynak SaaS'a dönüştürme" yoluyla açık kaynak topluluğuna verilen zararı engeller — bu projeden yararlanan herhangi bir ticari kullanıcı, topluluğa geri katkıda bulunmalıdır.

**MIT lisanslı kısımlar bu maddeye tabi değildir**, yalnızca üst kaynak (upstream) opencode ekibi tarafından kontrol edilir.

### Orijinal opencode ekibi ile ilişki

- ✅ Bu proje, [opencode](https://github.com/sst/opencode) üst kaynak koduna **dayanmaktadır**.
- ❌ Bu projenin opencode resmi ekibi (sst / anomalyco) ile **hiçbir bağlılık veya yetkilendirme ilişkisi yoktur**.
- ❌ Bu proje, opencode'un resmi yayın sürümü değildir ve resmi üst kaynağa destek taahhüdü vermez.
- ❌ **OpenCode resmi ekibi, bu dal için herhangi bir teknik destek, garanti veya onay sağlamaz** (üst kaynak README'sindeki açık aitlik gereksinimi uyarınca).
- ✅ Bu projenin DAG iş akışı motoru, Çince özellik HATA AYIKLAMA (DEBUG) gibi geliştirmeleri yazar tarafından bağımsız olarak sürdürülmektedir.
- ✅ Üst kaynak MIT kodunun aitliği tamamen korunmuş olup, yazar ve telif hakkı beyanları değiştirilmemiştir.

OpenCode'un resmi sürümünü kullanmak isterseniz, lütfen https://opencode.ai veya https://github.com/sst/opencode adresini ziyaret edin.

## Belge Dizini

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Harness-DAG-Workflow tam belgeleri
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Çince özellik düzeltmeleri listesi
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Yukarı akış opencode yeteneklerinin korunma açıklaması
- [`NOTICE`](./NOTICE) — Lisans sınırları ve atıf beyanı
- [`AGENTS.md`](./AGENTS.md) — İkincil geliştirme ve katkı kılavuzu

## Katkıda Bulunma

Katkıda bulunmakla ilgileniyorsanız, PR göndermeden önce lütfen [`CONTRIBUTING.md`](./CONTRIBUTING.md) dosyasını okuyunuz.

### Bu fork üzerine geliştirme yapma

Proje adınızda "opencode" kullanıyorsanız (örneğin "opencode-dashboard" veya "opencode-mobile" gibi), lütfen README dosyanızda projenin OpenCode ekibi tarafından resmi olarak geliştirilmediğini ve bu fork yazarıyla hiçbir ilişkisi olmadığını belirtiniz.

## Sıkça Sorulan Sorular (SSS)

### Bu, Claude Code'dan nasıl farklıdır?

İşlevsellik açısından oldukça benzerdir. Temel farklar:

- %100 açık kaynak
- Belirli bir sağlayıcıya bağlı değildir. [OpenCode Zen](https://opencode.ai/zen) modelleri önerilir, ancak Claude, OpenAI, Google ve hatta yerel modellerle de kullanılabilir
- Yerleşik LSP desteği
- Terminal arayüzüne (TUI) odaklanır
- İstemci/sunucu mimarisi. Yerel makinede çalıştırılabilir ve aynı anda mobil cihazla uzaktan kontrol edilebilir

### Bu, opencode'un resmi sürümünden nasıl farklıdır?

- Harness-DAG-Workflow iş akışı motoru eklenmiştir (AGPL-3.0)
- Çince kullanım senaryolarındaki uyumluluk sorunları sürekli olarak düzeltilmektedir
- Uzun vadeli bağımsız bakım, yukarı akış temposundan ayrıştırılmıştır

## Topluluk

- 📖 [Yukarı akış opencode topluluğu](https://opencode.ai)
- 📝 [Bu dalın issue bölümü](./issues) (sorun geri bildirimi ve yeni özellik önerileri)
