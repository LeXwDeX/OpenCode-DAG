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
  <a href="./README.br.md"><b>Português (Brasil)</b></a> ·
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

> **Um fork aprimorado do [opencode](https://github.com/anomalyco/opencode) com um motor de workflow DAG de grau de produção para orquestração multi-agente.**

Construído sobre o agente de IA para terminal [opencode](https://github.com/anomalyco/opencode) licenciado pelo MIT. **Sem afiliação nem endosso da equipe OpenCode.**

---

## Status dos branches

| Branch | Base | Conteúdo | Status |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + otimização de ferramentas | ✅ **Estável** |
| **`dag-branch`** | main + DAG | Motor de workflow DAG (114 arquivos) | 🔧 **Em desenvolvimento** — adaptando para as APIs da v1.17.11 |

> [!IMPORTANT]
> O **motor de workflow DAG está sendo portado** atualmente da v1.15.10 para a base de código v1.17.11.
> Ele vive no branch `dag-branch` e **ainda não é funcional**. O branch `main` é totalmente utilizável com Hooks,
> o loop automático do Goal e a exposição de exceções das ferramentas — tudo pronto para produção.

---

## O que torna este fork diferente

### 📌 Estável no `main`

#### API de Hooks (26 eventos × 5 tipos de execução)

Compatibilidade completa com o protocolo de hooks do Claude Code: tipos de hook `command`, `mcp`, `http`, `prompt`, `agent` com 26 eventos de hook incluindo `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, e mais. Os hooks carregam de uma cadeia `hooks.json` global / do projeto / da worktree, ou podem ser registrados por sessão em tempo de execução pela HTTP API; o controle opcional de confiança do workspace (`requireTrust` + o comando `/trust`) limita a execução de hooks aos diretórios que você aprovou.

Veja a [referência de hooks](./packages/core/src/plugin/skill/configure-hooks.md).

#### Loop automático do Goal

Um loop de agente autônomo que conduz continuamente um agente em direção a um objetivo definido pelo usuário. Um juiz LLM decide após cada turno se o objetivo foi alcançado ou precisa de mais turnos, dentro de um orçamento de turnos configurável. `/goal <alvo>` para definir, `/subgoal` para adicionar subobjetivos, `/goal resume` para continuar um objetivo pausado.

#### Exposição de exceções de ferramentas

- **Reparo de JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — repara escapes Unicode multibyte quebrados no JSON gerado pelos LLMs
- **Validação da ferramenta Question**: formatação estruturada de erros com dicas em nível de campo e exemplos de chamadas corretas
- **Descrições das ferramentas**: docs `.txt` ampliados para `question`, `task`, `skill`, `webfetch`, `websearch` com seções de Parâmetros + Retorno
- **Correção do pipe do shell**: `stdout/stderr: "pipe"` em todas as chamadas a `ChildProcess.make` + drenagem graceful da fiber de leitura

### 🔧 Em desenvolvimento no `dag-branch`

#### Motor de workflow DAG (AGPL-3.0)

Um **motor de workflow de grafo direcionado acíclico (DAG)** que permite aos agentes LLM orquestrar tarefas paralelas complexas multi-nó dentro de uma única sessão.

> ⚠️ **Status**: Copiado bruto do fork v1.15.10 (114 arquivos). 217 erros de tipo pendentes de adaptação às APIs (`Database.use` síncrono → `Database.Service` baseado em Effect, `Bus` → `EventV2Bridge`, etc.). Ainda não compilável.

| Funcionalidade | Descrição |
|---|---|
| **Agendamento automático** | Gera agentes filhos com base na ordem de dependências, em paralelo quando possível |
| **Replanejamento dinâmico** | Adicionar/remover/atualizar nós e ajustar a concorrência durante a execução |
| **Integridade da máquina de estados** | Quatro leis fundamentais: é proibido contornar a máquina de estados, estados terminais são irreversíveis, eventos devem ser transmitidos, persistir antes de mutar |
| **TUI de terminal** | Painel de controle DAG completo com mapa topológico de caracteres de bloco, visão em árvore, diálogos de nós, atualizações em tempo real |
| **Recuperação de quedas** | Detecta e retoma workflows órfãos em execução ao reiniciar |
| **Ramificação condicional** | Os nós podem executar ou ser ignorados condicionalmente com base na saída a montante |
| **Aninhamento de sub-DAG** | O tipo de worker `dag` gera sub-workflows recursivos (profundidade máxima 3) |
| **Auditoria persistente** | Esquema SQLite de 6 tabelas, todas as transições de estado rastreáveis |

### Correções de CJK e de localização

Numerosas correções para o tratamento de texto chinês/japonês/coreano: tokenização, pontuação de largura total, caminhos de arquivos, entrada IME na interface do terminal. Veja a [lista de correções](./docs/localization/zh-hans-fixes.md).

### Isolamento duplo: Sandbox + Worktree

- **Sandbox** — diretórios temporários efêmeros com diagnósticos LSP para experimentos de código seguros
- **Worktree** — isolamento `git worktree` por workflow para edição multi-agente em paralelo

---

## Instalação

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Remova versões anteriores a 0.1.x antes de instalar.

---

## Mantenha o upstream — e mais

Todas as capacidades do upstream licenciadas pelo MIT são totalmente preservadas:

- **App desktop** (macOS / Windows / Linux) — baixe pelos [releases](https://github.com/anomalyco/opencode/releases)
- **Agentes Build & Plan** — `Tab` para alternar entre modos de acesso total e somente leitura
- **Multi-provedor** — Claude, OpenAI, Google, modelos locais via [OpenCode Zen](https://opencode.ai/zen)
- **LSP integrado** — diagnósticos em tempo real dos servidores de linguagem
- **Arquitetura cliente/servidor** — rode localmente, controle remotamente do celular

Este fork adiciona o motor DAG, as correções CJK, o workspace de codificação sandbox e o rastreamento de objetivos por cima — sem quebrar nada.

---

## Licença

Este repositório usa um **modelo de licença misto**:

| Conteúdo | Licença | Localização |
|---------|---------|----------|
| Código do opencode upstream (a grande maioria) | **MIT** | [`LICENSE`](./LICENSE) |
| Motor de workflow DAG desenvolvido internamente | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Detalhes completos dos limites em [`NOTICE`](./NOTICE).

> ⚖️ **Por que AGPL?** O motor DAG é o trabalho diferenciador principal. AGPL garante que qualquer derivado — incluindo implantações SaaS — precise contribuir de volta.

---

## Documentação

- [`docs/harness-dag.md`](./docs/harness-dag.md) — arquitetura e uso do motor DAG
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — catálogo de correções CJK
- [`NOTICE`](./NOTICE) — limites de licença e atribuição
- [`AGENTS.md`](./AGENTS.md) — guia de contribuição e desenvolvimento

## Comunidade

- 📖 [Comunidade opencode upstream](https://opencode.ai)
- 📝 [Rastreador de issues do fork](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
