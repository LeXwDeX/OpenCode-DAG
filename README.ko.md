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
  <a href="./README.ko.md"><b>한국어</b></a> ·
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

> **[opencode](https://github.com/anomalyco/opencode)의 향상된 fork로, 멀티 에이전트 오케스트레이션을 위한 프로덕션급 DAG 워크플로 엔진을 내장하고 있습니다.**

MIT 라이선스의 [opencode](https://github.com/anomalyco/opencode) 터미널 AI 에이전트를 기반으로 구축되었습니다. **OpenCode 팀과의 어떠한 제휴나 보증 관계도 없습니다.**

---

## 브랜치 상태

| 브랜치 | 기준 | 내용 | 상태 |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + 도구 최적화 | ✅ **안정** |
| **`dag-branch`** | main + DAG | DAG 워크플로 엔진(114 files) | 🔧 **개발 중** —— v1.17.11 API 적응 작업 중 |

> [!IMPORTANT]
> **DAG 워크플로 엔진은 현재 v1.15.10에서 v1.17.11** 코드베이스로 **이식 중**입니다.
> `dag-branch`에 존재하며, **아직 작동하지 않습니다**. `main` 브랜치는 완전히 사용 가능하며,
> Hooks, Goal 자동 루프, 도구 예외 노출을 갖추고 있습니다 —— 모두 프로덕션 준비 완료입니다.

---

## 이 fork가 다른 점

### 📌 `main`의 안정 기능

#### Hooks API(26 events × 5 execution types)

Claude Code hooks 프로토콜과의 완전한 호환성: `command`, `mcp`, `http`, `prompt`, `agent` 5가지 hook 타입에 `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate` 등 26개의 hook 이벤트를 포함합니다. Hooks는 글로벌 / 프로젝트 / worktree의 `hooks.json` 체인에서 로드되거나, HTTP API를 통해 세션 단위로 런타임에 등록할 수도 있습니다. 선택적 워크스페이스 신뢰 게이트(`requireTrust` + `/trust` 명령)를 통해 승인한 디렉터리에서만 hook 실행을 제한할 수 있습니다.

자세한 내용은 [hooks 레퍼런스](./packages/core/src/plugin/skill/configure-hooks.md)를 참조하십시오.

#### Goal 자동 루프

사용자 정의 목표를 향해 에이전트를 지속적으로 구동하는 자율 에이전트 루프입니다. LLM 판정자가 각 턴 종료 후 목표 달성 여부 또는 추가 턴 필요 여부를 판단하며, 구성 가능한 턴 예산 내에서 실행됩니다. `/goal <target>`으로 목표를 설정하고, `/subgoal`로 하위 목표를 추가하며, `/goal resume`으로 일시정지된 목표를 재개하십시오.

#### 도구 예외 노출

- **JSON 수리**: `safeParseJson` + `fixJsonUnicodeEscapes` —— LLM 생성 JSON에서 손상된 멀티바이트 유니코드 이스케이프를 수리
- **Question 도구 검증**: 필드 수준 힌트와 올바른 호출 예시를 포함한 구조화된 오류 포맷팅
- **도구 설명**: `question`, `task`, `skill`, `webfetch`, `websearch`의 `.txt` 문서를 확장하여 Parameters + Returns 섹션을 추가
- **셸 파이프 수정**: 모든 `ChildProcess.make` 호출에 `stdout/stderr: "pipe"` + reader 파이버의 정상적 배출 적용

### 🔧 `dag-branch`의 개발 중 기능

#### DAG 워크플로 엔진(AGPL-3.0)

**방향성 비순환 그래프(DAG) 워크플로 엔진**으로, LLM 에이전트가 단일 세션 내에서 복잡한 다중 노드 병렬 작업을 조율할 수 있게 합니다.

> ⚠️ **상태**: v1.15.10 fork에서 그대로 복사(114 files). API 적응 대기 중인 타입 오류 217건(동기 `Database.use` → Effect 기반 `Database.Service`, `Bus` → `EventV2Bridge` 등). 아직 컴파일되지 않습니다.

| 기능 | 설명 |
|---|---|
| **자동 스케줄링** | 의존성 순서에 따라 자식 에이전트를 생성하고, 가능한 곳에서 병렬 처리 |
| **동적 재계획** | 실행 중 노드 추가/삭제/업데이트 및 동시성 조정 |
| **상태 머신 무결성** | 네 가지 철칙: 상태 머신 우회 금지, 종단 상태 불가역, 이벤트 브로드캐스트 필수, 변경 전 영속화 |
| **터미널 TUI** | 블록 문자 토폴로지 맵, 트리 뷰, 노드 대화상자, 실시간 업데이트를 갖춘 완전한 DAG 제어판 |
| **크래시 복구** | 재시작 시 고아화된 실행 중 워크플로를 감지하고 재개 |
| **조건 분기** | 상위 출력에 따라 노드를 조건부로 실행하거나 건너뛸 수 있음 |
| **서브 DAG 중첩** | `dag` worker 타입이 재귀적 서브 워크플로를 생성(max depth 3) |
| **영속적 감사** | 6-table SQLite schema, 모든 상태 전환 추적 가능 |

### CJK 및 로컬라이제이션 수정

중국어/일본어/한국어 텍스트 처리에 대한 광범위한 수정: 토큰화, 전각 구두점, 파일 경로, 터미널 UI에서의 IME 입력. 자세한 내용은 [수정 목록](./docs/localization/zh-hans-fixes.md)을 참조하십시오.

### 이중 격리: Sandbox + Worktree

- **Sandbox** —— LSP 진단을 제공하는 임시 디렉터리로 안전한 코드 실험 지원
- **Worktree** —— 워크플로마다 `git worktree`를 할당하여 병렬 다중 에이전트 편집을 격리

---

## 설치

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> 설치 전 0.1.x 미만의 이전 버전을 제거하십시오.

---

## 상류 기능 전부 유지 —— 그리고 추가

상류의 MIT 라이선스 기능은 모두 완전히 보존됩니다:

- **데스크톱 앱**(macOS / Windows / Linux) —— [releases](https://github.com/anomalyco/opencode/releases)에서 다운로드
- **Build & Plan 에이전트** —— `Tab`으로 전체 접근과 읽기 전용 모드 전환
- **멀티 프로바이더** —— Claude, OpenAI, Google, 로컬 모델을 [OpenCode Zen](https://opencode.ai/zen) 통해 사용
- **내장 LSP** —— 언어 서버로부터의 실시간 진단
- **클라이언트/서버 아키텍처** —— 로컬에서 실행, 모바일에서 원격 조종

이 fork는 그 위에 DAG 엔진, CJK 수정, sandbox 코딩 워크스페이스, 목표 추적을 추가합니다 —— 기존 기능을 손상시키지 않고.

---

## 라이선스

이 저장소는 **혼합 라이선스 모델**을 사용합니다:

| 내용 | 라이선스 | 위치 |
|---------|---------|----------|
| 상류 opencode 코드(대부분) | **MIT** | [`LICENSE`](./LICENSE) |
| 자체 개발 DAG 워크플로 엔진 | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

전체 경계 세부사항은 [`NOTICE`](./NOTICE)에 있습니다.

> ⚖️ **왜 AGPL인가?** DAG 엔진은 핵심 차별화 산출물입니다. AGPL은 파생물 —— SaaS 배포를 포함 —— 이 반드시 커뮤니티에 환원되도록 보장합니다.

---

## 문서

- [`docs/harness-dag.md`](./docs/harness-dag.md) —— DAG 엔진 아키텍처 및 사용법
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) —— CJK 수정 카탈로그
- [`NOTICE`](./NOTICE) —— 라이선스 경계 및 귀속
- [`AGENTS.md`](./AGENTS.md) —— 기여 및 개발 가이드

## 커뮤니티

- 📖 [상류 opencode 커뮤니티](https://opencode.ai)
- 📝 [Fork 이슈 트래커](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
