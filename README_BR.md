<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README_EN.md">English</a> ·
  <a href="./README_AR.md">العربية</a> ·
  <a href="./README_BR.md"><b>Português (Brasil)</b></a> ·
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

> **⚠️ Português (Brasil) / Brazilian Portuguese — MACHINE TRANSLATION**
> This document was machine-translated from the Chinese primary README.md using DeepSeek V4. No native-speaker review has been performed. For authoritative content, please refer to the [Chinese primary README](./README.md) or the [English README](./README_EN.md). If you'd like to help improve this translation, please open an issue or pull request.

# OpenCode (Edição Aprimorada)

> **⚠️ Aviso**: Este projeto é um fork otimizado do [opencode](https://github.com/sst/opencode), mantido por um desenvolvedor independente com base na versão original. Este projeto **não tem relação com a equipe oficial do OpenCode** e não possui qualquer vínculo. O projeto original foi lançado pela equipe opencode sob a licença MIT. Este fork preserva a licença MIT upstream e adiciona diversos módulos próprios (veja [NOTICE](./NOTICE)).

## Introdução

Este projeto é uma **versão modificada e aprimorada** da versão oficial do opencode, com os objetivos:

- 🔧 **Corrigir problemas de características chinesas**: DEBUG de vários problemas de compatibilidade upstream relacionados a segmentação de palavras em chinês, processamento de caracteres CJK, pontuação de largura total, caminhos com caracteres chineses e cenários com IME chinês (veja [Lista de correções para características chinesas](./docs/localization/zh-hans-fixes.md))
- 🧩 **Fornecer um motor de fluxo de trabalho DAG de nível de produção**: motor próprio [Harness-DAG-Workflow](./docs/harness-dag.md), permitindo que agentes LLM orquestrem e executem tarefas paralelas com múltiplos nós em uma única sessão
- 🎯 **Manter compatibilidade com upstream**: todo o código upstream sob licença MIT é mantido inalterado, sem quebrar a construção original nem poluir a API upstream

## Instalação

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
> Antes de instalar, remova versões antigas anteriores à 0.1.x.


## Características exclusivas deste branch

Este branch é construído sobre o opencode upstream, **adicionando** ou **melhorando significativamente** as seguintes capacidades (detalhes em cada seção):

| Recurso | Descrição resumida | Licença |
|------|------|------|
| 🧩 Sistema de orquestração DAG HARNESS | Permite que um agente LLM orquestre fluxos de trabalho paralelos com múltiplos nós em uma única sessão | AGPL-3.0 |
| 🪝 Implementação do superconjunto HOOKS API | Sistema completo de Hooks com 22 eventos de runtime × 5 tipos de execução | MIT + aprimoramentos deste branch |
| 🛡️ Espaço de isolamento CODING leve | Ambiente de execução isolado de duas vias: Sandbox + Worktree | MIT + aprimoramentos deste branch |
| 🔧 DEBUG de recursos para chinês | Segmentação CJK / pontuação de largura total / compatibilidade com IME / caminhos com chinês | MIT |
| 🔬 Outras pequenas correções (DEBUG) | Copiar e colar, largura de caracteres do Leste Asiático, truncamento de saída em chinês, etc. | MIT |

### 🧩 Sistema de orquestração de tarefas DAG HARNESS (módulo desenvolvido internamente · AGPL-3.0)

Anteriormente conhecido como Harness-DAG-Workflow. Um mecanismo de fluxo de trabalho **DAG (Directed Acyclic Graph)** de nível de produção, permitindo que agentes LLM orquestrem tarefas paralelas complexas em uma única sessão. Capacidades principais:

- **Agendamento automático**: cria automaticamente subagentes com base nas dependências dos nós, executando em paralelo
- **Replanejamento dinâmico**: permite replanejar o fluxo de trabalho em tempo de execução (adicionar/remover/modificar nós, ajustar limite de concorrência)
- **Conformidade rígida**: máquina de estados não contornável, estado final irreversível, eventos sempre transmitidos, persistência prioritária
- **Integração com comandos slash**: `/dag-ctl` para controle de execução, `/dag-worker` para configuração do fluxo de trabalho
- **Auditoria persistente**: esquema SQLite com 6 tabelas, todas as mudanças de estado são rastreáveis

Para a arquitetura completa, veja a [documentação do Harness-DAG-Workflow](./docs/harness-dag.md); para guia de desenvolvimento, veja [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Licença**: Este módulo ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) e modelos/documentos relacionados) é distribuído sob a licença **GNU AGPL v3** — o uso deste módulo exige a abertura do código-fonte de todas as modificações. Consulte [NOTICE](./NOTICE) e [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE)

### 🪝 Implementação do superconjunto HOOKS API

Este branch mantém e aprimora integralmente o sistema Hooks API do upstream:

- **22 eventos de runtime acionados**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 tipos de execução**: `command` (shell) / `mcp` (ferramenta MCP) / `http` (REST) / `prompt` (LLM em uma rodada) / `agent` (LLM em múltiplas rodadas)
- **Protocolo de comunicação por envelope JSON via stdin/stdout**: a documentação completa do protocolo está em [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Aprimoramentos deste branch**: integração com o barramento de eventos do fluxo DAG (eventos `workflow.*` / `node.*`) + assinatura TUI + encaminhamento via HTTP API

### 🛡️ Espaço de isolamento CODING leve

Este branch oferece um ambiente de execução isolado de duas vias, permitindo que agentes/usuários executem código em uma sandbox segura sem poluir o repositório real:

| Nível de isolamento | Mecanismo | Uso |
|---------|------|------|
| **Sandbox** (leve) | Diretório temporário + diagnóstico LSP + cadeia de ferramentas multilíngue (Python/Node/TS/Go/Rust/C/C++) | Execução de teste para arquivos únicos / pequenos experimentos |
| **Worktree** (pesado) | Ramo independente via `git worktree` + visão de sistema de arquivos separada | Edição paralela por múltiplos agentes, refatorações em larga escala |

- 📦 **Ferramenta Sandbox**: `packages/opencode/src/tool/sandbox.ts`, cada sandbox possui cache de dependências isolado (venv / node_modules), suporta modo `ephemeral` de uso único e tarefas longas `background` assíncronas.
- 🌳 **Gerenciador DAG Worktree**: no fluxo de trabalho DAG, cada nó paralelo pode ser automaticamente atribuído a um ramo worktree independente; após a conclusão do nó, a mesclagem é feita via `git merge` na linha principal.

### 🔧 DEBUG de recursos para chinês (problemas do upstream corrigidos)

Foram realizadas depurações e otimizações para diversos problemas de compatibilidade/experiência no uso do chinês encontrados na versão upstream, abrangendo:

- **Segmentação de texto chinês e contagem de tokens**: tratamento de caracteres CJK em tokenizadores que antes causavam anomalias.
- **Compatibilidade com pontuação de largura total**: tolerância a dois-pontos, aspas e parênteses de largura total na análise de configuração.
- **Tratamento de caminhos com chinês**: transmissão correta de caminhos de arquivos contendo espaços e caracteres CJK em hooks/sandboxes.
- **Compatibilidade com IME (Input Method Editor) para chinês**: latência de entrada e trepidação do cursor no TUI durante a janela de candidatos do IME.

O registro detalhado das correções e os testes de regressão estão em [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Se você encontrar outros problemas com recursos em chinês, por favor, envie os passos de reprodução na [área de issues](./issues); continuarei depurando.

### 🔬 Outras pequenas correções (correções do upstream já integradas)

Este branch mantém integralmente várias correções de pequenos problemas de experiência do upstream, todas verificadas por testes de regressão:

| Problema | Commit da correção no upstream | Impacto |
|------|-----------------|----------|
| 📋 **Conteúdo danificado ao copiar e colar** — o conteúdo colado pelo usuário é truncado ou perde caracteres no TUI | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | Experiência de entrada no TUI |
| 📐 **Layout não atualizado após colar** — a altura da caixa de prompt não se ajusta automaticamente após colar textos longos, causando truncamento visual | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | Experiência de entrada no TUI |
| 📎 **Sem fallback ao falhar a gravação na área de transferência** — quando a API `navigator.clipboard` falha (ambientes HTTP, etc.), a operação de cópia lança erro diretamente | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Compatibilidade entre navegadores |
| 🎨 **Contraste insuficiente da cor do texto do emblema de colagem** — o texto do emblema de resumo da operação de colar fica ilegível em alguns temas | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | Experiência visual do TUI |
| 📏 **Estimativa de largura de caracteres CJK / do Leste Asiático** — a largura de exibição de emojis, caracteres de largura total, ideogramas, etc. não corresponde à ocupação real, causando desalinhamento do cursor | Integrada ao sistema de correção de segmentação CJK | Alinhamento de caracteres no TUI |
| ⌨️ **Tremedeira da janela de candidatos do IME** — ao ativar IME para chinês/japonês, ocorre trepidação do cursor + atraso na inserção de caracteres | Patch de workaround local | Experiência de entrada no TUI |

> Este branch não reinventa a roda: as correções já feitas pelo upstream serão sincronizadas conforme a fusão com o branch `stable`; este branch foca principalmente na depuração de problemas de recursos em chinês e questões relacionadas ao fluxo de trabalho DAG que o upstream ainda não tratou.


## Capacidades mantidas do upstream

As seguintes capacidades são provenientes integralmente do opencode upstream (licença MIT), sem modificações funcionais neste fork:

### Aplicativo de desktop (BETA)

O OpenCode também oferece um aplicativo de desktop. Pode ser baixado diretamente da [página de releases](https://github.com/anomalyco/opencode/releases) ou de [opencode.ai/download](https://opencode.ai/download).

| Plataforma            | Arquivo de download                              |
| --------------------- | ------------------------------------------------ |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg`            |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`                |
| Windows               | `opencode-desktop-windows-x64.exe`               |
| Linux                 | `.deb`, `.rpm` ou AppImage                        |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agents

O OpenCode inclui dois Agentes que podem ser alternados rapidamente com a tecla `Tab`:

- **build** - modo padrão, com permissões completas, adequado para desenvolvimento
- **plan** - modo somente leitura, adequado para análise e exploração de código
  - recusa modificações de arquivos por padrão
  - pergunta antes de executar comandos bash
  - útil para explorar bases de código desconhecidas ou planejar alterações

Além disso, há um sub-agente **general** para buscas complexas e tarefas de múltiplas etapas, de uso interno; também pode ser chamado digitando `@general` em uma mensagem.

Saiba mais sobre [Agents](https://opencode.ai/docs/agents).

### Implementação do superconjunto da API ClaudeCode Hooks

Este fork mantém integralmente o sistema de API Hooks do upstream com 22 eventos de gatilho em tempo de execução. Os hooks são registrados no campo `hooks` do arquivo de configuração por nome de evento, suportando cinco tipos de execução: `command`, `mcp`, `http`, `prompt`, `agent`, comunicando-se via envelopes JSON por stdin/stdout. Veja o protocolo completo em [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

A lista detalhada de eventos e a tabela de tipos de execução estão disponíveis em [seção mantida do README original](./docs/readmes/upstream-features.md).

## Licenciamento e Atribuição

Este repositório adota um **modelo de licenciamento híbrido**:

| Conteúdo | Licença | Localização |
|----------|---------|-------------|
| Código upstream do opencode (a grande maioria dos arquivos) | **MIT** | veja [`LICENSE`](./LICENSE) |
| Motor de fluxo de trabalho DAG próprio (`packages/opencode/src/dag/` e ferramentas, modelos, documentos relacionados) | **GNU AGPL v3** | veja [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Consulte o arquivo [`NOTICE`](./NOTICE) para a descrição completa dos limites.


### 🔒 Declaração de Licença Obrigatória AGPL v3 (Restrição Rígida deste Branch)

**Política do autor deste projeto para desenvolvimento derivado neste repositório:**

1. **Código próprio deve adotar a GNU AGPL v3** — qualquer código novo, reescrito ou significativamente modificado pelo autor deste branch **deve** ser licenciado sob a GNU Affero General Public License v3 ou versão posterior (AGPL-3.0-or-later)
2. **Requisito de copyleft da AGPL** — qualquer projeto que utilize, modifique ou derive de módulos AGPL-3.0 (como o motor de workflow DAG) **deve abrir seu código-fonte completo sob AGPL-3.0** e fornecer acesso aos usuários finais
3. **Obrigação de código aberto para SaaS** — se você implantar este projeto ou trabalhos derivados como um serviço de rede (SaaS / plataforma de nuvem), você **deve fornecer um link para download do código-fonte completo a todos os usuários que utilizarem o serviço** (esta é a cláusula central que diferencia a AGPL da GPL, §13)
4. **Atribuição preservada** — devem ser mantidas as declarações do autor original, as notificações de direitos autorais e as informações de atribuição no arquivo NOTICE

> ⚖️ **Por que a AGPL?** O autor acredita que o valor do software livre está na colaboração contínua. A AGPL impede que a prática de "SaaS de código fechado" prejudique a comunidade de código aberto — qualquer uso comercial que se beneficie deste projeto deve retribuir à comunidade.

**A parte licenciada sob MIT não está sujeita a estes termos**, sendo controlada exclusivamente pela equipe upstream do opencode.


### Relação com a equipe original do opencode

- ✅ Este projeto é **baseado** no código upstream do [opencode](https://github.com/sst/opencode)
- ❌ Este projeto **não possui qualquer afiliação ou relação de autorização** com a equipe oficial do opencode (sst / anomalyco)
- ❌ Este projeto não é uma versão oficial de lançamento do opencode e não oferece compromisso de suporte ao upstream oficial
- ❌ **A equipe oficial do OpenCode não fornece qualquer suporte técnico, garantia ou endosso a este branch** (conforme exigências de atribuição explícitas no README upstream)
- ✅ As melhorias como o motor de workflow DAG, a depuração de funcionalidades em chinês, etc., são mantidas independentemente pelo autor
- ✅ A atribuição do código upstream sob licença MIT é integralmente preservada, sem adulteração dos avisos de autoria e direitos autorais

Para utilizar a versão oficial do opencode, acesse https://opencode.ai ou https://github.com/sst/opencode .

## Índice de documentação

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Documentação completa do Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Lista de correções para características chinesas
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Descrição das capacidades mantidas do upstream opencode
- [`NOTICE`](./NOTICE) — Declaração de limites de licenciamento e atribuição
- [`AGENTS.md`](./AGENTS.md) — Guia para desenvolvimento secundário e contribuição

## Contribuindo

Se tiver interesse em contribuir com código, leia [`CONTRIBUTING.md`](./CONTRIBUTING.md) antes de enviar um PR.

### Desenvolvendo com base neste fork

Se você usar "opencode" no nome do seu projeto (como "opencode-dashboard" ou "opencode-mobile"), indique no README que o projeto não é desenvolvido oficialmente pela equipe OpenCode e não possui vínculo com o autor deste fork.

## Perguntas frequentes (FAQ)

### Como isso difere do Claude Code?

Funcionalmente, é muito semelhante. Principais diferenças:

- 100% código aberto
- Não está vinculado a um provedor específico. Recomenda-se usar modelos do [OpenCode Zen](https://opencode.ai/zen), mas também pode usar Claude, OpenAI, Google ou até modelos locais
- Suporte LSP incorporado
- Focado na interface de terminal (TUI)
- Arquitetura cliente/servidor. Pode rodar localmente e ser controlado remotamente por dispositivos móveis

### Como isso difere da versão oficial do opencode?

- Adiciona o motor de fluxo de trabalho Harness-DAG-Workflow (AGPL-3.0)
- DEBUG contínuo de problemas de compatibilidade em cenários de uso com chinês
- Manutenção independente de longo prazo, desacoplada do ritmo upstream

## Comunidade

- 📖 [Comunidade upstream do opencode](https://opencode.ai)
- 📝 [Área de issues deste fork](./issues) (relatar problemas e sugerir novos recursos)