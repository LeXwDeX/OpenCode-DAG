<!--
**Machine Translation Notice**
This document was machine-translated from Chinese (zh-CN) to Español using DeepSeek v4 Pro.
Source: README.md (Chinese original)
Translation model: deepseek-v4-pro (http://192.168.33.110:8000/v1)
Date: 2026-06-07
For authoritative information, refer to the original Chinese version: README.md
-->

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
  <a href="./README_ES.md"><b>Español</b></a> ·
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

# OpenCode (Edición Mejorada)

> **⚠️ Aviso**: Este proyecto es una rama optimizada de [opencode](https://github.com/sst/opencode), mantenida por un desarrollador independiente sobre la base original. Este proyecto **no está afiliado al equipo oficial de OpenCode** y no existe ninguna relación de dependencia. El proyecto original fue publicado por el equipo de opencode bajo la licencia MIT; esta rama conserva la licencia MIT original y añade varios módulos de desarrollo propio (consulte [NOTICE](./NOTICE)).

## Introducción

Este proyecto es una **versión modificada y mejorada** de la edición oficial de opencode, con los siguientes objetivos:

- 🔧 **Corregir problemas con las características del chino**: Depurar varios problemas de compatibilidad en escenarios con segmentación de palabras en chino, manejo de caracteres CJK, puntuación de ancho completo, rutas de archivo en chino y métodos de entrada en chino (IME) presentes en la versión original (consulte la [Lista de correcciones para características del chino simplificado](./docs/localization/zh-hans-fixes.md))
- 🧩 **Proporcionar un motor de flujo de trabajo DAG de grado productivo**: Desarrollo propio de [Harness-DAG-Workflow](./docs/harness-dag.md), que permite a un agente LLM orquestar y dirigir tareas paralelas de múltiples nodos en una sola sesión
- 🎯 **Mantener la compatibilidad con la versión original**: Todo el código bajo licencia MIT de la versión original se conserva tal cual, sin romper la construcción existente ni contaminar la API original

## Instalación

```bash
# Instalación directa (YOLO)
curl -fsSL https://opencode.ai/install | bash

# Gestores de paquetes
npm i -g opencode-ai@latest        # También se puede usar bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS y Linux (recomendado, siempre actualizado)
brew install opencode              # macOS y Linux (fórmula oficial de brew, actualización menos frecuente)
sudo pacman -S opencode            # Arch Linux (Estable)
paru -S opencode-bin               # Arch Linux (Última desde AUR)
mise use -g opencode               # Cualquier sistema
nix run nixpkgs#opencode           # O use github:anomalyco/opencode para obtener la última rama de desarrollo
```

> [!TIP]
> Antes de instalar, por favor elimine las versiones anteriores a la 0.1.x.

## Características exclusivas de esta rama

Esta rama se construye sobre el proyecto opencode y **agrega** o **mejora significativamente** las siguientes capacidades (detalles en cada sección):

| Característica | Descripción breve | Licencia |
|------|------|------|
| 🧩 DAG HARNESS – Sistema de orquestación de tareas | Permite al agente LLM orquestar flujos de trabajo paralelos multinodo en una sola sesión | AGPL-3.0 |
| 🪝 Implementación superset de la API HOOKS | Sistema completo de Hooks con 22 eventos de ejecución × 5 tipos de ejecución | MIT + mejoras de esta rama |
| 🛡️ Espacio de aislamiento de CODING ligero | Entorno de ejecución aislado de doble vía: Sandbox + Worktree | MIT + mejoras de esta rama |
| 🔧 Depuración de funciones para chino | Segmentación CJK / puntuación de ancho completo / compatibilidad con IME / rutas en chino | MIT |
| 🔬 Otras pequeñas depuraciones | Copiar y pegar, anchura de caracteres de Asia Oriental, truncamiento de salida en chino, etc. | MIT |

### 🧩 DAG HARNESS – Sistema de orquestación de tareas (módulo propio · AGPL-3.0)

Anteriormente conocido como Harness-DAG-Workflow. Un motor de flujo de trabajo basado en **grafos acíclicos dirigidos (DAG)** listo para producción, que permite al agente LLM orquestar tareas paralelas complejas en una sola sesión. Capacidades principales:

- **Planificación automática**: genera subagentes automáticamente según las dependencias del nodo y los ejecuta en paralelo
- **Replanificación dinámica**: puede replanificar el flujo de trabajo en tiempo real durante la ejecución (agregar, eliminar o modificar nodos, ajustar el límite de concurrencia)
- **Cumplimiento estricto de reglas**: máquina de estados no eludible, estados finales irreversibles, eventos siempre transmitidos, persistencia prioritaria
- **Integración con comandos Slash**: `/dag-ctl` para controlar la ejecución, `/dag-worker` para configurar flujos de trabajo
- **Auditoría persistente**: esquema de 6 tablas en SQLite, todos los cambios de estado son trazables

Para la arquitectura completa, consulte la [documentación de Harness-DAG-Workflow](./docs/harness-dag.md); para la guía de desarrollo, vea [AGENTS.md](./packages/opencode/src/dag/AGENTS.md).

> **Licencia**: Este módulo ([`packages/opencode/src/dag/`](./packages/opencode/src/dag/), [`packages/opencode/src/tool/dag-worker.ts`](./packages/opencode/src/tool/dag-worker.ts), [`packages/opencode/src/tool/node_complete.ts`](./packages/opencode/src/tool/node_complete.ts) y las plantillas y documentación relacionadas) se publica bajo la licencia **GNU AGPL v3** — el uso de este módulo requiere liberar todas las modificaciones como código abierto. Consulte [NOTICE](./NOTICE) y [packages/opencode/src/dag/LICENSE](./packages/opencode/src/dag/LICENSE) para más detalles.

### 🪝 Implementación superset de la API HOOKS

Esta rama conserva y mejora completamente el sistema de API de Hooks del proyecto original:

- **22 eventos de activación en tiempo de ejecución**: `PreToolUse` / `PostToolUse` / `FileChanged` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle` / `PreCompact` / `PostCompact` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange` / `InstructionsLoaded` / `StopFailure` / `PostToolUseFailure`
- **5 tipos de ejecución**: `command` (shell) / `mcp` (herramienta MCP) / `http` (REST) / `prompt` (LLM de una sola ronda) / `agent` (LLM de múltiples rondas)
- **Protocolo de comunicación con envoltura JSON stdin/stdout**: la documentación completa del protocolo está en [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **Mejoras de esta rama**: integración del bus de eventos del flujo de trabajo DAG (eventos `workflow.*` / `node.*`) + suscripción TUI + reenvío a API HTTP

### 🛡️ Espacio de aislamiento de CODING ligero

Esta rama proporciona un entorno de ejecución aislado de doble vía, que permite al agente/usuario ejecutar código de prueba en un sandbox seguro sin contaminar el repositorio real:

| Nivel de aislamiento | Mecanismo | Uso |
|---------|------|------|
| **Sandbox** (ligero) | Directorio temporal + diagnóstico LSP + cadena de herramientas multilenguaje (Python/Node/TS/Go/Rust/C/C++) | Prueba de ejecución de código para archivos individuales o experimentos pequeños |
| **Worktree** (pesado) | Rama independiente con `git worktree` + vista de sistema de archivos separada | Edición paralela por múltiples agentes, refactorizaciones a gran escala |

- 📦 **Herramienta Sandbox**: `packages/opencode/src/tool/sandbox.ts`, cada sandbox tiene su propia caché de dependencias (venv / node_modules), compatible con modo desechable `ephemeral` y tareas largas asíncronas `background`
- 🌳 **Administrador de Worktree del DAG**: en un flujo de trabajo DAG, cada nodo paralelo puede asignarse automáticamente a una rama de worktree independiente, y al completarse se fusiona a la línea principal mediante `git merge`

### 🔧 Depuración de funciones para chino (problemas corregidos del proyecto original)

Se han depurado y optimizado varios problemas de compatibilidad y experiencia encontrados en escenarios de uso con chino, incluyendo:

- **Segmentación de texto en chino y conteo de tokens**: manejo anómalo de caracteres CJK en algunos tokenizadores
- **Compatibilidad con puntuación de ancho completo**: tolerancia a fallos en el análisis de configuración con dos puntos, comillas y paréntesis de ancho completo
- **Manejo de rutas en chino**: transmisión correcta de rutas de archivo que contienen espacios y caracteres CJK en hooks/sandbox
- **Compatibilidad con métodos de entrada (IME) para chino**: latencia de entrada y vibración del cursor en TUI durante la ventana de candidatos de IME

Los registros de correcciones y las pruebas de regresión se encuentran en [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md).

> 💡 Si encuentra otros problemas relacionados con funciones en chino durante el uso, por favor proporcione los pasos para reproducirlos en la [sección de issues](./issues); continuaré depurándolos.

### 🔬 Otras pequeñas depuraciones (correcciones integradas del proyecto original)

Esta rama conserva completamente varias correcciones para pequeños problemas de experiencia del proyecto original, verificadas mediante pruebas de regresión:

| Problema | Commit de la corrección original | Alcance del impacto |
|------|-----------------|----------|
| 📋 **Contenido dañado al copiar y pegar** — el contenido del prompt pegado por el usuario se trunca incorrectamente o pierde caracteres en TUI | `564cde393e` [#28156](https://github.com/anomalyco/opencode/pull/28156) | Experiencia de entrada en TUI |
| 📐 **Diseño no actualizado después de pegar** — la altura del cuadro de prompt no se expande automáticamente al pegar texto largo, causando un truncamiento visual | `1124315267` [#28164](https://github.com/anomalyco/opencode/pull/28164) | Experiencia de entrada en TUI |
| 📎 **Fallo al escribir en el portapapeles sin alternativa** — cuando la API `navigator.clipboard` falla (entorno HTTP, etc.), la operación de copia simplemente arroja un error | `fe143df151` [#27993](https://github.com/anomalyco/opencode/pull/27993) | Compatibilidad entre navegadores |
| 🎨 **Contraste insuficiente del color de primer plano en la insignia de pegado** — el texto del resumen de pegado es difícil de leer en algunos temas | `e94aecaa08` [#27969](https://github.com/anomalyco/opencode/pull/27969) | Experiencia visual en TUI |
| 📏 **Estimación incorrecta del ancho de caracteres CJK / de Asia Oriental** — el ancho de visualización de emoji, caracteres de ancho completo y otros caracteres de Asia Oriental no coincide con el espacio ocupado real, causando desalineación del cursor | Incluido en el sistema de corrección de segmentación CJK | Alineación de caracteres en TUI |
| ⌨️ **Vibración de la ventana de candidatos IME** — al activar métodos de entrada de chino/japonés, el cursor vibra y hay retardo en la inserción de caracteres | Parche de solución provisional local | Experiencia de entrada en TUI |

> Esta rama no reinventa la rueda: las correcciones ya aplicadas en el proyecto original se sincronizan mediante la rama `stable`; esta rama se centra principalmente en depurar problemas relacionados con funciones chinas y flujos de trabajo DAG que aún no han sido tratados en el proyecto original.

## Capacidades conservadas de la versión original

Las siguientes capacidades provienen completamente de la versión original de opencode (licencia MIT); esta rama no ha realizado modificaciones funcionales:

### Aplicación de escritorio (BETA)

OpenCode también ofrece una versión de escritorio. Se puede descargar directamente desde la [página de lanzamientos (releases page)](https://github.com/anomalyco/opencode/releases) o desde [opencode.ai/download](https://opencode.ai/download).

| Plataforma            | Archivo de descarga                   |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` o AppImage             |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

### Agentes

OpenCode incluye dos agentes integrados, que se pueden alternar rápidamente con la tecla `Tab`:

- **build** - Modo predeterminado, con permisos completos, adecuado para tareas de desarrollo
- **plan** - Modo de solo lectura, adecuado para el análisis y la exploración de código
  - Rechaza modificar archivos por defecto
  - Pregunta antes de ejecutar comandos bash
  - Útil para explorar bases de código desconocidas o planificar cambios

Además, incluye un sub-agente **general**, para búsquedas complejas y tareas de varios pasos, de uso interno; también se puede invocar escribiendo `@general` en un mensaje.

Más información en [Agents](https://opencode.ai/docs/agents).

### Implementación superconjunto de la API de Hooks de ClaudeCode

Esta rama conserva íntegramente el sistema de la API de Hooks de la versión original y sus 22 eventos de activación en tiempo de ejecución. Los hooks se registran en el campo `hooks` del archivo de configuración por nombre de evento, y admiten cinco tipos de ejecución: `command`, `mcp`, `http`, `prompt` y `agent`, comunicándose mediante sobres JSON a través de stdin/stdout. El protocolo completo se encuentra en [`packages/opencode/src/session/prompt/hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md).

La lista detallada de eventos y la tabla de tipos de ejecución se encuentra en [la sección conservada del README original](./docs/readmes/upstream-features.md).

## Licencia y atribución

Este repositorio utiliza un **modelo de licencia mixta**:

| Contenido | Licencia | Ubicación |
|------|------|------|
| Código original de opencode (la gran mayoría de los archivos) | **MIT** | Consulte [`LICENSE`](./LICENSE) |
| Motor de flujo de trabajo DAG de desarrollo propio (`packages/opencode/src/dag/` y herramientas, plantillas y documentación relacionadas) | **GNU AGPL v3** | Consulte [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

La descripción completa de los límites se encuentra en el archivo [`NOTICE`](./NOTICE).

### 🔒 Declaración obligatoria de licencia AGPL v3 (restricción estricta de esta rama)

**Política del autor de este proyecto para el desarrollo secundario de este repositorio:**

1. **El código propio debe estar bajo GNU AGPL v3** — cualquier código añadido, reescrito o modificado significativamente por el autor de esta rama **debe** usar la GNU Affero General Public License v3 o superior (AGPL-3.0-or-later)
2. **Requisito de copyleft (contagioso) de la AGPL** — cualquier proyecto que utilice, modifique o derive de módulos bajo AGPL-3.0 (como el motor de flujo de trabajo DAG) **debe publicar su código fuente completo bajo AGPL-3.0** y proporcionar acceso a los usuarios finales
3. **Publicación obligatoria del código fuente para SaaS** — si despliegas este proyecto o sus derivados como un servicio de red (SaaS / plataforma en la nube), **debes proporcionar a todos los usuarios de dicho servicio un enlace de descarga del código fuente completo** (esta es la cláusula central de la AGPL que la distingue de la GPL, §13)
4. **Atribución** — se debe conservar la declaración del autor original, los avisos de derechos de autor y la información de atribución en el archivo NOTICE

> ⚖️ **¿Por qué AGPL?** El autor cree que el valor del software de código abierto reside en la colaboración continua. La AGPL evita que el "SaaS de código cerrado" perjudique a la comunidad de código abierto — cualquier uso comercial que se beneficie de este proyecto debe contribuir de vuelta a la comunidad.

**Las partes bajo la licencia MIT no están sujetas a esta disposición**, son controladas únicamente por el equipo upstream de opencode.

### Relación con el equipo original de opencode

- ✅ Este proyecto está **basado** en el código upstream de [opencode](https://github.com/sst/opencode)
- ❌ Este proyecto **no tiene ninguna afiliación ni relación de autorización** con el equipo oficial de opencode (sst / anomalyco)
- ❌ Este proyecto no es una versión oficial de opencode, y no ofrece compromisos de soporte para el upstream oficial
- ❌ **El equipo oficial de OpenCode no proporciona ningún soporte técnico, garantía ni respaldo a esta rama** (según los requisitos explícitos de atribución del README upstream)
- ✅ El motor de flujo de trabajo DAG, la depuración de características para chino y otras mejoras de este proyecto son mantenidas de forma independiente por el autor
- ✅ La atribución del código MIT upstream se conserva íntegramente, sin alterar las declaraciones de autoría ni derechos de autor

Si deseas utilizar la versión oficial de opencode, visita https://opencode.ai o https://github.com/sst/opencode .

## Índice de documentación

- [`docs/harness-dag.md`](./docs/harness-dag.md) — Documentación completa de Harness-DAG-Workflow
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — Lista de correcciones para características del chino
- [`docs/readmes/upstream-features.md`](./docs/readmes/upstream-features.md) — Notas sobre las capacidades conservadas de opencode original
- [`NOTICE`](./NOTICE) — Declaración de límites de licencia y atribución
- [`AGENTS.md`](./AGENTS.md) — Guía de desarrollo secundario y contribuciones

## Contribuciones

Si está interesado en contribuir con código, por favor lea [`CONTRIBUTING.md`](./CONTRIBUTING.md) antes de enviar un PR.

### Desarrollo basado en este fork

Si utiliza "opencode" en el nombre de su proyecto (por ejemplo, "opencode-dashboard" o "opencode-mobile"), por favor indique en el README que el proyecto no es desarrollado oficialmente por el equipo de OpenCode ni está afiliado al autor de este fork.

## Preguntas Frecuentes (FAQ)

### ¿En qué se diferencia de Claude Code?

Funcionalmente es muy similar; las diferencias clave son:

- 100% código abierto
- No está vinculado a un proveedor específico. Se recomienda usar modelos de [OpenCode Zen](https://opencode.ai/zen), pero también funciona con Claude, OpenAI, Google e incluso modelos locales
- Soporte LSP integrado
- Enfoque en la interfaz de terminal (TUI)
- Arquitectura cliente/servidor. Puede ejecutarse en su máquina local y controlarse de forma remota desde un dispositivo móvil
- **🪝 Superset de Hooks API**: sobre los 22 eventos disparadores × 5 tipos de ejecución de Claude Code, este fork es **totalmente compatible con el protocolo Claude Code Hooks** y añade integración con el bus de eventos DAG (`workflow.*` / `node.*`), suscripciones TUI y reenvío mediante HTTP API. Especificación completa: [`hooks-reference.md`](./packages/opencode/src/session/prompt/hooks-reference.md)
- **🎯 Sistema de instrucciones Goal**: la herramienta `todowrite` + seguimiento estructurado de objetivos mantienen la cola de trabajo del agent durante sesiones largas de varios pasos y evitan perder el estado de las tareas cuando cambia la ventana de contexto
- **🪝 TODO PreHook**: permite inyectar la lista TODO en el contexto mediante hooks `PreToolUse`; el mecanismo de reentrada a objetivos impulsado por hooks garantiza que el agent siempre vea el progreso actual
- **🛡️ Sandbox Coding Workspace**: cada sandbox tiene su propio directorio temporal, diagnósticos LSP y toolchains multilenguaje (Python/Node/TS/Go/Rust/C/C++); el agent puede probar, compilar y depurar código de forma aislada y fusionarlo en los archivos del proyecto mediante edit/write solo después de verificarlo

### ¿En qué se diferencia de la versión oficial de opencode?

- **🪝 Superset de Hooks API + instrucciones Goal + TODO PreHook + Sandbox Workspace**: conserva todas las capacidades Hooks del upstream y añade integración de eventos DAG, seguimiento estructurado de tareas, reentrada a objetivos impulsada por hooks y un coding sandbox multilenguaje aislado
- **🧩 Modo DAG WorkFlow (WIP · ~90%)**: motor [Harness-DAG-Workflow](./docs/harness-dag.md) desarrollado internamente que permite a un agent LLM orquestar tareas paralelas de varios nodos en una sola sesión. Las capacidades principales ya están implementadas (planificación / ciclo de vida / pause-resume-cancel-replan-step / sub-DAG / ramificación condicional / data flow / crash recovery / probes), el panel TUI está conectado y queda trabajo de pulido final
- **🔧 Correcciones de compatibilidad con chino**: DEBUG continuo de tokenización CJK, puntuación de ancho completo, rutas chinas y casos límite de IME heredados del upstream
- Mantenimiento independiente a largo plazo, desacoplado del ritmo de la versión original

## Comunidad

- 📖 [Comunidad de opencode original](https://opencode.ai)
- 📝 [Sección de issues de este fork](./issues) (para reportar problemas y sugerir nuevas funcionalidades)
