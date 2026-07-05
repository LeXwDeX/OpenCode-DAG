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
  <a href="./README.es.md"><b>Español</b></a> ·
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

> **Un fork mejorado de [opencode](https://github.com/anomalyco/opencode) con un motor de flujo de trabajo DAG de calidad de producción para la orquestación multi-agente.**

Construido sobre el agente de IA para terminal [opencode](https://github.com/anomalyco/opencode) con licencia MIT. **Sin afiliación ni respaldo del equipo de OpenCode.**

---

## Estado de las ramas

| Rama | Base | Contenido | Estado |
|--------|------|---------|--------|
| **`main`** | v1.17.11 | Hooks + Goal + optimización de herramientas | ✅ **Estable** |
| **`dag-branch`** | main + DAG | Motor de flujo de trabajo DAG (114 archivos) | 🔧 **En desarrollo** — adaptando a las API de v1.17.11 |

> [!IMPORTANT]
> El **motor de flujo de trabajo DAG está siendo portado** actualmente de v1.15.10 a la base de código v1.17.11.
> Vive en la rama `dag-branch` y **aún no es funcional**. La rama `main` es totalmente utilizable con Hooks,
> el bucle automático de Goal y la exposición de excepciones de herramientas — todo listo para producción.

---

## Qué diferencia a este fork

### 📌 Estable en `main`

#### API de Hooks (26 eventos × 5 tipos de ejecución)

Compatibilidad completa con el protocolo de hooks de Claude Code: tipos de hook `command`, `mcp`, `http`, `prompt`, `agent` con 26 eventos de hook incluyendo `PreToolUse`, `PostToolUse`, `SessionStart`, `PermissionRequest`, `WorktreeCreate`, y más. Los hooks se cargan desde una cadena `hooks.json` global / de proyecto / de worktree, o pueden registrarse por sesión en tiempo de ejecución a través de la HTTP API; el control opcional de confianza del espacio de trabajo (`requireTrust` + el comando `/trust`) limita la ejecución de hooks a los directorios que hayas aprobado.

Consulta la [referencia de hooks](./packages/core/src/plugin/skill/configure-hooks.md).

#### Bucle automático de Goal

Un bucle de agente autónomo que dirige continuamente a un agente hacia un objetivo definido por el usuario. Un juez LLM decide después de cada turno si el objetivo se ha alcanzado o necesita más turnos, dentro de un presupuesto de turnos configurable. `/goal <objetivo>` para establecerlo, `/subgoal` para añadir subobjetivos, `/goal resume` para continuar un objetivo en pausa.

#### Exposición de excepciones de herramientas

- **Reparación de JSON**: `safeParseJson` + `fixJsonUnicodeEscapes` — repara escapes Unicode multibyte rotos en el JSON generado por los LLM
- **Validación de la herramienta Question**: formateo estructurado de errores con pistas a nivel de campo y ejemplos de llamadas correctas
- **Descripciones de herramientas**: docs `.txt` ampliados para `question`, `task`, `skill`, `webfetch`, `websearch` con secciones de Parámetros + Retorno
- **Corrección del pipe del shell**: `stdout/stderr: "pipe"` en todas las llamadas a `ChildProcess.make` + drenado graceful de la fibra de lectura

### 🔧 En desarrollo en `dag-branch`

#### Motor de flujo de trabajo DAG (AGPL-3.0)

Un **motor de flujo de trabajo de grafo dirigido acíclico (DAG)** que permite a los agentes LLM orquestar tareas paralelas complejas multi-nodo dentro de una sola sesión.

> ⚠️ **Estado**: Copiado en bruto del fork v1.15.10 (114 archivos). 217 errores de tipo pendientes de adaptación a las API (`Database.use` síncrono → `Database.Service` basado en Effect, `Bus` → `EventV2Bridge`, etc.). Aún no compilable.

| Funcionalidad | Descripción |
|---|---|
| **Planificación automática** | Genera agentes hijos según el orden de dependencias, en paralelo cuando es posible |
| **Replanificación dinámica** | Añadir/eliminar/actualizar nodos y ajustar la concurrencia durante la ejecución |
| **Integridad de la máquina de estados** | Cuatro leyes de hierro: se prohíbe eludir la máquina de estados, los estados terminales son irreversibles, los eventos deben emitirse, persistir antes de mutar |
| **TUI de terminal** | Panel de control DAG completo con mapa topológico de caracteres de bloque, vista de árbol, diálogos de nodos, actualizaciones en tiempo real |
| **Recuperación de caídas** | Detecta y reanuda flujos de trabajo huérfanos en ejecución al reiniciar |
| **Ramificación condicional** | Los nodos pueden ejecutarse u omitirse condicionalmente según la salida aguas arriba |
| **Anidamiento de sub-DAG** | El tipo de worker `dag` genera subflujos de trabajo recursivos (profundidad máxima 3) |
| **Auditoría persistente** | Esquema SQLite de 6 tablas, todas las transiciones de estado trazables |

### Correcciones de CJK y de localización

Numerosas correcciones para el manejo de texto chino/japonés/coreano: tokenización, puntuación de ancho completo, rutas de archivos, entrada IME en la interfaz de terminal. Consulta la [lista de correcciones](./docs/localization/zh-hans-fixes.md).

### Doble aislamiento: Sandbox + Worktree

- **Sandbox** — directorios temporales efímeros con diagnósticos LSP para experimentos de código seguros
- **Worktree** — aislamiento `git worktree` por flujo de trabajo para edición multi-agente en paralelo

---

## Instalación

```bash
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode
scoop install opencode
# ...and more — see upstream docs
```

> [!TIP]
> Elimina las versiones anteriores a 0.1.x antes de instalar.

---

## Conserva el upstream — y más

Todas las capacidades del upstream con licencia MIT se conservan íntegramente:

- **Aplicación de escritorio** (macOS / Windows / Linux) — descárgala desde los [releases](https://github.com/anomalyco/opencode/releases)
- **Agentes Build & Plan** — `Tab` para alternar entre modos de acceso total y solo lectura
- **Multi-proveedor** — Claude, OpenAI, Google, modelos locales vía [OpenCode Zen](https://opencode.ai/zen)
- **LSP integrado** — diagnósticos en tiempo real desde servidores de lenguajes
- **Arquitectura cliente/servidor** — ejecuta en local, controla en remoto desde el móvil

Este fork añade el motor DAG, las correcciones CJK, el workspace de codificación sandbox y el seguimiento de objetivos encima — sin romper nada.

---

## Licencia

Este repositorio usa un **modelo de licencia mixto**:

| Contenido | Licencia | Ubicación |
|---------|---------|----------|
| Código de opencode upstream (la gran mayoría) | **MIT** | [`LICENSE`](./LICENSE) |
| Motor de flujo de trabajo DAG de desarrollo propio | **GNU AGPL v3** | [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Detalles completos de los límites en [`NOTICE`](./NOTICE).

> ⚖️ **¿Por qué AGPL?** El motor DAG es el trabajo diferenciador principal. AGPL garantiza que cualquier derivado — incluidos los despliegues SaaS — deba contribuir de vuelta.

---

## Documentación

- [`docs/harness-dag.md`](./docs/harness-dag.md) — arquitectura y uso del motor DAG
- [`docs/localization/zh-hans-fixes.md`](./docs/localization/zh-hans-fixes.md) — catálogo de correcciones CJK
- [`NOTICE`](./NOTICE) — límites de licencia y atribución
- [`AGENTS.md`](./AGENTS.md) — guía de contribución y desarrollo

## Comunidad

- 📖 [Comunidad opencode upstream](https://opencode.ai)
- 📝 [Seguimiento de issues del fork](./issues)
- 🔗 [GitHub](https://github.com/LeXwDeX/OpenCode-DAG)
