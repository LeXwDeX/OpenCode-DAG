<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (c) 2026 포크 저자 (귀속은 NOTICE 파일 참조).
GNU AGPL v3 하에 라이선스됩니다. 모든 변경 사항은 오픈 소스로 공개되어야 합니다.
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
  <a href="./README_KO.md"><b>한국어</b></a> ·
  <a href="./README_NO.md">Norsk</a> ·
  <a href="./README_PL.md">Polski</a> ·
  <a href="./README_RU.md">Русский</a> ·
  <a href="./README_TH.md">ไทย</a> ·
  <a href="./README_TR.md">Türkçe</a> ·
  <a href="./README_UK.md">Українська</a>
</p>

# OpenCode (기능 확장판)

> **⚠️ 고지 사항**: 본 프로젝트는 [opencode](https://github.com/sst/opencode)의 기능 확장 포크로, 독립 개발자가 유지 관리합니다. OpenCode 공식 팀과 **제휴, 승인, 공식 지원 관계가 전혀 없습니다**. 원본 프로젝트는 opencode 팀이 MIT 라이선스로 공개합니다. 본 포크는 업스트림의 MIT 라이선스 코드를 기능적으로 유지하면서, 새 독자 모듈을 더 강력한 카피레프트 라이선스로 추가합니다. 자세한 내용은 [NOTICE](./NOTICE)를 참조하십시오.

## 소개

본 프로젝트는 업스트림 `opencode`의 **재설계 및 기능 확장판**으로, 다음 요소에 중점을 둡니다:

- 🔧 **중국어 관련 예외 케이스 수정** — 업스트림 버전에서 발견된 CJK 토큰화, 전자폭 구두점, 중국어 경로, IME 상호작용 버그를 수정 ([CJK 수정 로그](./docs/localization/zh-hans-fixes.md) 참조)
- 🧩 **프로덕션급 DAG 워크플로 엔진 제공** — 자체 개발한 [Harness-DAG-Workflow](./docs/harness-dag.md)으로 LLM 에이전트가 단일 세션 내에서 다중 노드 병렬 작업을 오케스트레이션 가능
- 🎯 **업스트림 호환성 유지** — 업스트림 MIT 라이선스 코드는 기능적으로 변경되지 않으며, 빌드 파괴나 API 오염이 없음

## 설치

```bash
# 직접 설치 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 패키지 관리자
npm i -g opencode-ai@latest        # bun/pnpm/yarn에서도 사용 가능
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 및 Linux (권장, 항상 최신)
brew install opencode              # macOS 및 Linux (공식 formula, 업데이트 빈도 낮음)
sudo pacman -S opencode            # Arch Linux (안정 버전)
paru -S opencode-bin               # Arch Linux (AUR에서 최신 버전)
mise use -g opencode               # 모든 OS
nix run nixpkgs#opencode           # 또는 github:anomalyco/opencode로 최신 dev 브랜치 사용
```

> [!TIP]
> 설치 전 0.1.x 이전 구버전을 제거하십시오.

## 본 브랜치 고유 기능

본 브랜치는 업스트림 opencode를 기반으로 구축되었으며, 다음과 같은 기능을 **새로 추가**하거나 **대폭 강화**하였습니다(자세한 내용은 각 절 참조):

| 기능 | 개요 | 라이선스 |
|------|------|------|
| 🧩 DAG HARNESS 오케스트레이션 작업 시스템 | LLM 에이전트가 단일 세션에서 다중 노드 병렬 워크플로를 오케스트레이션 | AGPL-3.0 |
| 🪝 HOOKS API 슈퍼셋 구현 | 22가지 런타임 이벤트 × 5가지 실행 유형의 완전한 Hooks 체계 | MIT + 본 브랜치 강화 |
| 🛡️ 경량 CODING 격리 공간 | Sandbox + Worktree 이중 격리 실행 환경 | MIT + 본 브랜치 강화 |
| 🔧 중국어 특성 DEBUG | CJK 분할 / 전각 문장 부호 / IME 호환 / 중국어 경로 | MIT |
| 🔬 기타 소규모 DEBUG | 복사 붙여넣기, 동아시아 언어 너비, 중국어 출력 잘림 등 | MIT |

### 🧩 DAG HARNESS 오케스트레이션 작업 시스템 (자체 개발 모듈 · AGPL-3.0)

이전 명칭은 Harness-DAG-Workflow입니다. LLM 에이전트가 단일 세션에서 복잡한 병렬 작업을 오케스트레이션할 수 있도록 하는 프로덕션급 **방향성 비순환 그래프(DAG) 워크플로 엔진**입니다. 핵심 기능:

- **자동 스케줄링**: 노드 의존성에 따라 자동으로 하위 에이전트를 생성(spawn)하여 병렬 실행
- **동적 재계획**: 실행 중 실시간으로 워크플로를 다시 계획(노드 추가/삭제/수정, 동시성 상한 조정)
- **철칙 준수**: 상태 머신 우회 불가, 최종 상태 되돌릴 수 없음, 이벤트 필수 브로드캐스트, 영속성 우선
- **슬래시 명령어 통합**: `/dag-ctl` 로 실행 제어, `/dag-worker` 로 워크플로 구성
- **영속성 감사**: SQLite 6 테이블 스키마, 모든 상태 변경 추적 가능

전체 아키텍처 설계는 [Harness-DAG-Workflow 문서](./docs/harness-dag.md)를, 개발 가이드는 [AGENTS.md](./packages/opencode/src/dag/AGENTS.md)를 참조하십시오.

> **라이선스**: 이 모듈([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) 및 관련 템플릿과 문서)은 **GNU AGPL v3** 라이선스로 배포됩니다. 이 모듈을 사용하려면 모든 수정 사항을 오픈소스로 공개해야 합니다. 자세한 내용은 [NOTICE](./NOTICE)와 [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)를 참조하십시오.

### 🪝 HOOKS API 슈퍼셋 구현

본 브랜치는 업스트림의 Hooks API 체계를 완전히 보존하고 강화했습니다:

- **22가지 런타임 트리거 이벤트**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5가지 실행 유형**: `command`(shell) / `mcp`(MCP 도구) / `http`(REST) / `prompt`(단일 턴 LLM) / `agent`(다중 턴 LLM)
- **stdin/stdout JSON 엔벨로프 통신 프로토콜**: 전체 프로토콜 문서는 [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)를 참조하십시오.
- **본 브랜치 강화**: DAG 워크플로 이벤트 버스 통합(`workflow.*` / `node.*` 이벤트) + TUI 구독 + HTTP API 포워딩

### 🛡️ 경량 CODING 격리 공간

본 브랜치는 에이전트/사용자가 실제 저장소를 오염시키지 않고 안전한 샌드박스에서 코드를 시험 실행할 수 있도록 이중 격리 실행 환경을 제공합니다:

| 격리 수준 | 메커니즘 | 용도 |
|---------|------|------|
| **Sandbox** (경량) | 임시 디렉터리 + LSP 진단 + 다중 언어 도구 체인(Python/Node/TS/Go/Rust/C/C++) | 단일 파일/소규모 실험 코드 시험 실행 |
| **Worktree** (중량) | `git worktree` 독립 브랜치 + 독립 파일 시스템 뷰 | 다중 에이전트 병렬 편집, 대규모 리팩터링 |

- 📦 **Sandbox 도구**: `packages/opencode/src/tool/sandbox.ts`, 각 sandbox는 독립적인 의존성 캐시(venv / node_modules)를 가지며, `ephemeral` 일회성 모드와 `background` 비동기 장기 작업을 지원합니다.
- 🌳 **DAG Worktree 관리자**: DAG 워크플로에서 각 병렬 노드는 자동으로 독립 worktree 브랜치에 할당되며, 노드 완료 후 `git merge`를 통해 메인라인에 병합됩니다.

### 🔧 중국어 특성 DEBUG (업스트림에서 수정된 문제)

업스트림 버전에서 중국어 사용 시나리오에서 발견된 여러 호환성/사용자 경험 문제에 대해 DEBUG 및 최적화를 수행하였으며, 다음을 포함합니다:

- **중국어 분할 및 토큰 카운팅**: 일부 토크나이저에서 CJK 문자의 비정상 처리
- **전각 문장 부호 호환**: 전각 콜론, 따옴표, 괄호의 설정 파싱 시 오류 허용
- **중국어 경로 처리**: 공백과 CJK 문자가 포함된 파일 경로의 후크/샌드박스에서 올바른 전달
- **중국어 입력기(IME) 호환**: IME 후보 창에서 TUI 입력 지연 및 커서 떨림

 구체적인 수정 기록 및 회귀 테스트는 [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md)를 참조하십시오.

> 💡 사용 중에 다른 중국어 특성 문제를 발견하시면 [issue 영역](./issues)에 재현 절차를 제출해 주십시오. 지속적으로 DEBUG하겠습니다.

### 🔬 기타 소규모 DEBUG (통합된 업스트림 수정 사항)

본 브랜치는 업스트림의 여러 소규모 사용자 경험 문제 수정 사항을 완전히 보존하였으며, 회귀 테스트로 검증하였습니다:

| 문제 | 업스트림 수정 커밋 | 영향 범위 |
|------|-----------------|----------|
| 📋 **복사 붙여넣기 내용 손상** — 사용자가 붙여넣은 프롬프트 내용이 TUI에서 잘못 잘리거나 문자가 손실됨 | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | TUI 입력 경험 |
| 📐 **붙여넣기 후 레이아웃 갱신 안 됨** — 긴 텍스트를 붙여넣은 후 프롬프트 상자 높이가 자동으로 늘어나지 않아 시각적 절단 발생 | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | TUI 입력 경험 |
| 📎 **클립보드 쓰기 실패 시 폴백 없음** — `navigator.clipboard` API가 실패할 경우(HTTP 환경 등), 복사 작업이 바로 오류 발생 | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | 크로스 브라우저 호환성 |
| 🎨 **붙여넣기 배지 전경색 대비 부족** — 붙여넣기 작업 요약 배지의 텍스트가 일부 테마에서 식별하기 어려움 | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | TUI 시각 경험 |
| 📏 **CJK / 동아시아 문자 너비 추정** — 이모지, 전각 문자, 한자 등 동아시아 너비 문자의 표시 너비가 실제 점유와 일치하지 않아 커서 위치가 어긋남 | CJK 분할 수정 체계에 포함됨 | TUI 문자 정렬 |
| ⌨️ **IME 후보 창 떨림** — 중국어/일본어 입력기 활성화 시 커서 떨림 + 문자 삽입 지연 | 로컬 workaround 패치 | TUI 입력 경험 |

> 본 브랜치는 바퀴를 재발명하지 않습니다: 업스트림에서 이미 수정된 문제는 `stable` 브랜치 병합 업데이트와 동기화되며, 본 브랜치는 주로 업스트림에서 아직 처리되지 않은 중국어 특성/DAG 워크플로 관련 문제를 DEBUG합니다.

## 업스트림에서 유지되는 기능 (MIT)

아래 기능들은 모두 업스트림 opencode 저장소(MIT 라이선스)에서 그대로 이관되었으며, 본 포크는 기능적 변경을 가하지 않았습니다.

### 데스크톱 앱 (베타)

데스크톱 애플리케이션으로도 제공됩니다. [릴리스 페이지](https://github.com/anomalyco/opencode/releases) 또는 [opencode.ai/download](https://opencode.ai/download)에서 다운로드하십시오.

| 플랫폼                  | 파일                                     |
| ----------------------- | ---------------------------------------- |
| macOS (Apple Silicon)   | `opencode-desktop-darwin-aarch64.dmg`    |
| macOS (Intel)           | `opencode-desktop-darwin-x64.dmg`        |
| Windows                 | `opencode-desktop-windows-x64.exe`       |
| Linux                   | `.deb`, `.rpm` 또는 AppImage             |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### 에이전트

OpenCode는 `Tab` 키로 전환 가능한 2개의 내장 에이전트를 제공합니다:

- **build** — 기본 모드, 전체 권한, 개발 작업용
- **plan** — 읽기 전용 모드, 코드 분석 및 탐색용
  - 기본적으로 파일 수정을 거부
  - bash 명령어 실행 전 확인 요청
  - 미지의 코드베이스 탐색이나 변경 계획 수립에 편리

복잡한 검색 및 다단계 작업용 **general** 서브 에이전트도 포함되어 있으며, `@general`을 인라인으로 지정해 호출할 수 있습니다.

[에이전트](https://opencode.ai/docs/agents)에 대해 더 알아보기.

### ClaudeCode Hooks API

본 포크는 업스트림 Hooks API 시스템 및 실행 시 트리거되는 22개 이벤트를 완전하게 유지합니다. Hooks는 구성 파일의 `hooks` 필드에 이벤트 이름으로 등록되며 `command`, `mcp`, `http`, `prompt`, `agent`의 다섯 가지 실행 타입을 지원합니다. stdin/stdout JSON 엔벨로프를 통해 통신합니다.

전체 프로토콜은 [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)를 참조하십시오.

전체 이벤트 표는 [업스트림 기능 유지 문서](./docs/readmes/upstream-features.md)를 참조하십시오.

## 라이선스 및 귀속

본 저장소는 **혼합 라이선스 모델**을 사용합니다:

| 내용                                                                                | 라이선스          | 위치                                                                               |
|-------------------------------------------------------------------------------------|-------------------|-----------------------------------------------------------------------------------|
| 업스트림 opencode 코드 (대다수 파일)                                                | **MIT**           | [`LICENSE`](./LICENSE)                                                             |
| 자체 개발 DAG 워크플로 엔진 (`packages/opencode/src/dag/` 및 관련 도구/템플릿/문서)   | **GNU AGPL v3**   | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE)          |

라이선스 경계에 대한 전체 설명은 [`NOTICE`](./NOTICE) 파일을 참조하십시오.

### 🔒 AGPL v3 강제 라이선스 선언 (본 브랜치 강제 제약)

**본 프로젝트 작성자의 본 저장소 2차 개발 정책:**

1. **자체 개발 코드는 반드시 GNU AGPL v3를 채택** — 본 브랜치 작성자가 새로 추가, 재작성 또는 현저히 수정한 모든 코드는 **반드시** GNU Affero General Public License v3 또는 그 이후 버전(AGPL-3.0-or-later)을 채택해야 합니다.
2. **AGPL의 전염성 요구 사항** — AGPL-3.0 모듈(DAG 워크플로 엔진 등)을 사용, 수정, 파생한 모든 프로젝트는 **반드시 AGPL-3.0으로 전체 소스 코드를 오픈소스화**해야 하며, 최종 사용자에게 접근을 제공해야 합니다.
3. **SaaS 강제 오픈소스** — 본 프로젝트 또는 그 파생물을 네트워크 서비스(SaaS/클라우드 플랫폼)로 배포하는 경우, 해당 서비스를 사용하는 모든 사용자에게 **전체 소스 코드 다운로드 링크를 반드시 제공해야 합니다**(이는 AGPL이 GPL과 구별되는 핵심 조항, §13입니다).
4. **저작자 표시 유지** — 원저작자 선언, 저작권 표시, NOTICE 파일의 귀속 정보를 반드시 유지해야 합니다.

> ⚖️ **왜 AGPL을 선택했나요?** 저자는 오픈소스 소프트웨어의 가치가 지속적인 협업에 있다고 생각합니다. AGPL은 '클로즈드 소스 SaaS화'가 오픈소스 커뮤니티에 끼치는 침해를 막습니다. 본 프로젝트로부터 이익을 얻는 모든 상업 사용자는 커뮤니티에 환원해야 합니다.

**MIT 라이선스 부분은 이 조항의 적용을 받지 않으며**, 오직 업스트림 opencode 팀이 관리합니다.

### 원 opencode 팀과의 관계

- ✅ 본 프로젝트는 [opencode](https://github.com/sst/opencode) 업스트림 코드를 **기반으로** 구축되었습니다.
- ❌ 본 프로젝트는 opencode 공식 팀(sst / anomalyco)과 **어떠한 소속 또는 승인 관계도 없습니다**.
- ❌ 본 프로젝트는 opencode 공식 릴리스 버전이 아니며, 공식 업스트림에 대한 지원을 약속하지 않습니다.
- ❌ **OpenCode 공식 팀은 본 브랜치에 대해 어떠한 기술 지원, 보증 또는 보증도 제공하지 않습니다**(업스트림 README의 명시적 귀속 요구에 따름).
- ✅ 본 프로젝트의 DAG 워크플로 엔진, 중국어 특성 DEBUG 등의 강화 사항은 작성자가 독립적으로 유지 관리합니다.
- ✅ 업스트림 MIT 코드의 귀속은 완전히 보존되며, 저작자와 저작권 선언이 훼손되지 않았습니다.

opencode 공식 버전을 사용하시려면 https://opencode.ai 또는 https://github.com/sst/opencode 를 방문하십시오.

## 문서 색인

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Harness-DAG-Workflow 전체 문서
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — 중국어 관련 수정 로그
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — 업스트림 opencode 기능 유지
- [`NOTICE`](./NOTICE) — 라이선스 경계 및 귀속
- [`AGENTS.md`](./AGENTS.md) — 기여자 / 2차 개발 가이드

## 기여하기

PR을 생성하기 전에 [`CONTRIBUTING.md`](./CONTRIBUTING.md)를 읽어주십시오.

### 본 포크 위에 개발하는 경우

프로젝트 이름에 "opencode"(예: "opencode-dashboard", "opencode-mobile")를 사용하는 경우, README에 해당 프로젝트가 OpenCode 팀이나 본 포크 저자와 공식적으로 개발되거나 제휴되지 않았음을 명시해 주십시오.

## 자주 묻는 질문 (FAQ)

### Claude Code와 어떻게 다른가요?

기능적으로 유사하나, 주요 차이점은 다음과 같습니다:

- 100% 오픈 소스
- 제공자 독립적 — [OpenCode Zen](https://opencode.ai/zen)을 권장하지만 Claude, OpenAI, Google, 로컬 모델과도 동작
- 내장 LSP 지원
- 터미널 UI(TUI)에 초점
- 클라이언트/서버 아키텍처 — 로컬에서 실행, 모바일에서 원격 구동
- **🪝 Hooks API 상위 집합**: Claude Code의 22개 트리거 이벤트 × 5개 실행 유형을 기반으로 하며, 이 포크는 **Claude Code Hooks 프로토콜과 완전히 호환**되고 DAG 워크플로 이벤트 버스 통합(`workflow.*` / `node.*` 이벤트), TUI 구독, HTTP API 포워딩을 추가합니다. 전체 사양: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 Goal 지시 시스템**: `todowrite` 도구와 구조화된 목표 추적으로 긴 다단계 agent 세션에서도 작업 큐를 유지하고, 컨텍스트 창 변화로 작업 상태가 사라지는 일을 줄입니다
- **🪝 TODO PreHook**: `PreToolUse` hook을 통해 TODO 목록을 컨텍스트에 주입할 수 있으며, hooks 기반 goal reentry 메커니즘으로 agent가 항상 현재 진행 상황을 볼 수 있게 합니다
- **🛡️ Sandbox Coding Workspace**: 각 sandbox는 독립된 임시 디렉터리, LSP 진단, 다중 언어 toolchain(Python/Node/TS/Go/Rust/C/C++)을 갖습니다. agent는 격리 환경에서 코드를 시험, 컴파일, 디버그하고 검증 후 edit/write로 프로젝트 파일에 병합할 수 있습니다

### 공식 opencode와 어떻게 다른가요?

- **🪝 Hooks API 상위 집합 + Goal 지시 + TODO PreHook + Sandbox Workspace**: upstream의 모든 Hooks 기능을 유지하면서 DAG 이벤트 통합, 구조화된 작업 추적, hooks 기반 goal reentry, 다중 언어 격리 coding sandbox를 추가합니다
- **🧩 DAG WorkFlow 모드(WIP · 약 90%)**: 자체 개발한 [Harness-DAG-Workflow](./docs/harness-dag.md) 엔진으로, LLM agent가 단일 세션에서 다중 노드 병렬 작업을 오케스트레이션할 수 있습니다. 핵심 기능(스케줄링 / 라이프사이클 / pause-resume-cancel-replan-step / sub-DAG / 조건 분기 / data flow / crash recovery / probes)은 구현되었고, TUI 패널도 연결되었으며, 남은 마무리 작업이 진행 중입니다
- **🔧 중국어 호환성 수정**: upstream에서 이어진 CJK tokenization, 전각 문장부호, 중국어 경로 처리, IME edge cases를 지속적으로 DEBUG합니다
- 독립 유지 관리, 업스트림 릴리스 주기와 분리

## 커뮤니티

- 📖 [업스트림 opencode 커뮤니티](https://opencode.ai)
- 📝 [본 포크의 이슈](./issues) (버그 신고 및 기능 제안)
