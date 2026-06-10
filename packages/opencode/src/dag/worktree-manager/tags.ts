// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Context } from "effect"
import type { IWorktreeManager } from "./IWorktreeManager"

// Extracted from dag/layer.ts to break the circular dependency chain:
// dag/layer → session/prompt → tool/registry → tool/dagworker →
// session/workflow-engine → dag/layer (WorktreeManagerTag was the leaf).
// workflow-engine now imports this tag directly from here instead of layer.
export class WorktreeManagerTag extends Context.Service<WorktreeManagerTag, IWorktreeManager>()(
  "@opencode/DAGWorktreeManager",
) {}
